#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>

static const int64_t marker = 0x43424741;
static _Atomic bool stopped = false, preempted = false, tapReady = false;
static IOPMAssertionID awake = 0;
static bool postedAny = false;
static double proofDeadline = 0;
static uint64_t acceptedGeneration = 0;
static int64_t acceptedStopEpoch = -1;
static NSString *acceptedSessionEpoch = nil, *acceptedHostInstance = nil;
static bool authorityMatches(NSDictionary *request) {
  NSDictionary *plan = request[@"plan"];
  return acceptedHostInstance &&
         [request[@"hostInstanceEpoch"] isEqual:acceptedHostInstance] &&
         [request[@"hostGeneration"] unsignedLongLongValue] ==
             acceptedGeneration &&
         [plan[@"stopEpoch"] longLongValue] == acceptedStopEpoch &&
         [plan[@"browserSessionEpoch"] isEqual:acceptedSessionEpoch];
}
static void emergencyStop(int signalNumber) {
  stopped = true;
  preempted = true;
}

static int treeBudget = 0;
static CFMachPortRef activeMonitorTap = NULL;
static pthread_mutex_t monitorLock = PTHREAD_MUTEX_INITIALIZER;
static bool monitorState(bool ready, bool enabled) { return ready && enabled; }
static bool inputMonitorActive(void) {
  pthread_mutex_lock(&monitorLock);
  CFMachPortRef tap = activeMonitorTap;
  if (tap)
    CFRetain(tap);
  pthread_mutex_unlock(&monitorLock);
  bool enabled = tap && CGEventTapIsEnabled(tap);
  if (tap)
    CFRelease(tap);
  return monitorState(tapReady, enabled);
}
static id attr(AXUIElementRef el, CFStringRef name) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(el, name, &value) != kAXErrorSuccess)
    return nil;
  return CFBridgingRelease(value);
}
static NSString *str(AXUIElementRef el, CFStringRef name) {
  id value = attr(el, name);
  return [value isKindOfClass:NSString.class] ? value
         : [value isKindOfClass:NSURL.class]  ? [value absoluteString]
                                              : @"";
}
static NSValue *bounds(AXUIElementRef el) {
  id p = attr(el, kAXPositionAttribute), s = attr(el, kAXSizeAttribute);
  if (!p || !s || CFGetTypeID((__bridge CFTypeRef)p) != AXValueGetTypeID() ||
      CFGetTypeID((__bridge CFTypeRef)s) != AXValueGetTypeID())
    return nil;
  CGPoint point;
  CGSize size;
  if (!AXValueGetValue((__bridge AXValueRef)p, kAXValueCGPointType, &point) ||
      !AXValueGetValue((__bridge AXValueRef)s, kAXValueCGSizeType, &size))
    return nil;
  return [NSValue valueWithRect:NSRectFromCGRect((CGRect){point, size})];
}
static NSArray *tree(AXUIElementRef el, int depth) {
  if (depth == 0)
    treeBudget = 20000;
  if (depth > 14 || --treeBudget < 0)
    return @[];
  NSArray *children = attr(el, kAXChildrenAttribute);
  if (![children isKindOfClass:NSArray.class])
    return @[];
  NSMutableArray *result = [NSMutableArray array];
  for (id child in
       [children subarrayWithRange:NSMakeRange(0, MIN(children.count, 200))]) {
    [result addObject:child];
    [result
        addObjectsFromArray:tree((__bridge AXUIElementRef)child, depth + 1)];
  }
  return result;
}
static bool locked(void) {
  NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
  return !session || [session[@"CGSSessionScreenIsLocked"] boolValue] ||
         ![session[@"kCGSSessionOnConsoleKey"] boolValue];
}
typedef struct {
  bool stopped, preempted, tapReady, accessibility, inputMonitoring, locked,
      chromeForeground;
} DesktopGuard;
static NSString *guardFailure(DesktopGuard state) {
  if (state.stopped || state.preempted)
    return @"input-stopped-or-user-preempted";
  if (!state.tapReady)
    return @"input-monitoring-not-active";
  if (!state.accessibility)
    return @"accessibility-permission-required";
  if (!state.inputMonitoring)
    return @"input-monitoring-permission-required";
  if (state.locked)
    return @"screen-locked-or-session-unavailable";
  if (!state.chromeForeground)
    return @"chrome-not-foreground";
  return nil;
}
static NSString *check(void) {
  return guardFailure((DesktopGuard){
      stopped, preempted, inputMonitorActive(), AXIsProcessTrusted(),
      CGPreflightListenEventAccess(), locked(),
      [NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier
          isEqual:@"com.google.Chrome"]});
}
static bool mapCssRect(CGRect content, CGRect css, double width, double height,
                       CGRect *mapped) {
  if (!isfinite(content.origin.x + content.origin.y + content.size.width +
                content.size.height + css.origin.x + css.origin.y +
                css.size.width + css.size.height + width + height) ||
      width <= 0 || height <= 0 || css.size.width <= 0 ||
      css.size.height <= 0 || css.origin.x < 0 || css.origin.y < 0 ||
      CGRectGetMaxX(css) > width || CGRectGetMaxY(css) > height)
    return false;
  double sx = content.size.width / width, sy = content.size.height / height;
  if (sx < 0.5 || sx > 3 || fabs(sx - sy) > 0.02)
    return false;
  *mapped = CGRectMake(content.origin.x + css.origin.x * sx,
                       content.origin.y + css.origin.y * sy,
                       css.size.width * sx, css.size.height * sy);
  return CGRectContainsRect(content, *mapped);
}
static void releaseAwake(void) {
  if (awake) {
    IOPMAssertionRelease(awake);
    awake = 0;
  }
}
static NSString *post(CGEventRef event) {
  NSString *error = check();
  if (!error && proofDeadline > 0 &&
      NSDate.date.timeIntervalSince1970 * 1000 > proofDeadline)
    error = @"target-proof-expired-before-input";
  if (!event)
    return @"event-create-failed";
  if (!error) {
    CGEventSetIntegerValueField(event, kCGEventSourceUserData, marker);
    CGEventPost(kCGHIDEventTap, event);
    postedAny = true;
  }
  CFRelease(event);
  return error;
}
static void releaseButton(CGPoint point) {
  CGEventRef event = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, point,
                                             kCGMouseButtonLeft);
  if (event) {
    CGEventSetIntegerValueField(event, kCGEventSourceUserData, marker);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
  }
}
static NSString *key(CGKeyCode code, CGEventFlags flags) {
  CGEventRef down = CGEventCreateKeyboardEvent(NULL, code, true);
  CGEventSetFlags(down, flags);
  NSString *error = post(down);
  if (error)
    return error;
  CGEventRef up = CGEventCreateKeyboardEvent(NULL, code, false);
  CGEventSetFlags(up, flags);
  CGEventSetIntegerValueField(up, kCGEventSourceUserData, marker);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(up);
  return check();
}
static NSString *inputText(NSString *text, bool numeric) {
  if (![text isKindOfClass:NSString.class] ||
      text.length > (numeric ? 8 : 80) ||
      [text rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet]
              .location != NSNotFound ||
      (numeric &&
       [text rangeOfCharacterFromSet:NSCharacterSet.decimalDigitCharacterSet
                                         .invertedSet]
               .location != NSNotFound))
    return @"input-text-not-allowed";
  NSString *error = key(0, kCGEventFlagMaskCommand);
  if (error)
    return error;
  UniChar chars[80];
  [text getCharacters:chars range:NSMakeRange(0, text.length)];
  CGEventRef event = CGEventCreateKeyboardEvent(NULL, 0, true);
  CGEventKeyboardSetUnicodeString(event, text.length, chars);
  error = post(event);
  CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
  CGEventSetIntegerValueField(up, kCGEventSourceUserData, marker);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(up);
  return error;
}
static NSString *validateAndExecute(NSDictionary *request) {
  if (!authorityMatches(request))
    return @"stale-native-dispatch-generation";
  NSString *error = check();
  if (error)
    return error;
  NSDictionary *plan = request[@"plan"], *proof = request[@"proof"],
               *target = plan[@"target"], *r = proof[@"rect"],
               *v = proof[@"viewport"];
  if (![plan isKindOfClass:NSDictionary.class] ||
      ![proof isKindOfClass:NSDictionary.class] ||
      ![target isKindOfClass:NSDictionary.class] ||
      ![r isKindOfClass:NSDictionary.class] ||
      ![v isKindOfClass:NSDictionary.class])
    return @"invalid-target-proof";
  if (![plan[@"actionId"] isEqual:proof[@"actionId"]] ||
      ![plan[@"pageId"] isEqual:proof[@"pageId"]] ||
      ![plan[@"pageGeneration"] isEqual:proof[@"pageGeneration"]] ||
      ![target isEqual:proof[@"semantic"]] || ![proof[@"hit"] boolValue])
    return @"proof-plan-mismatch";
  double age = NSDate.date.timeIntervalSince1970 * 1000 -
               [proof[@"sampledAt"] doubleValue];
  if (age < 0 || age > 1500)
    return @"stale-target-proof";
  proofDeadline = [proof[@"sampledAt"] doubleValue] + 1500;
  NSURLComponents *url = [NSURLComponents componentsWithString:proof[@"url"]];
  if (![url.scheme isEqual:@"https"] ||
      ![url.host isEqual:@"xyq.cbg.163.com"] || url.user || url.password)
    return @"wrong-page-origin";
  double x = [r[@"x"] doubleValue], y = [r[@"y"] doubleValue],
         w = [r[@"width"] doubleValue], h = [r[@"height"] doubleValue],
         vw = [v[@"width"] doubleValue], vh = [v[@"height"] doubleValue];
  if (!isfinite(x + y + w + h + vw + vh) || w <= 0 || h <= 0 || vw <= 0 ||
      vh <= 0 || x < 0 || y < 0 || x + w > vw || y + h > vh ||
      [v[@"scale"] doubleValue] != 1)
    return @"invalid-coordinate-space";
  pid_t pid =
      NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  id window = attr(app, kAXFocusedWindowAttribute);
  CFRelease(app);
  if (!window)
    return @"chrome-window-unavailable";
  NSValue *windowValue = bounds((__bridge AXUIElementRef)window);
  if (!windowValue)
    return @"native-window-frame-unavailable";
  CGRect windowFrame = NSRectToCGRect(windowValue.rectValue);
  NSArray *nodes = tree((__bridge AXUIElementRef)window, 0);
  NSMutableArray *areas = [NSMutableArray array];
  for (id node in nodes) {
    AXUIElementRef el = (__bridge AXUIElementRef)node;
    if ([str(el, kAXRoleAttribute) isEqual:@"AXWebArea"] &&
        [str(el, CFSTR("AXURL")) isEqual:proof[@"url"]])
      [areas addObject:node];
  }
  if (areas.count != 1)
    return @"native-page-url-unverified";
  NSValue *web = bounds((__bridge AXUIElementRef)areas[0]);
  if (!web)
    return @"native-content-frame-unavailable";
  CGRect content =
      CGRectIntersection(NSRectToCGRect(web.rectValue), windowFrame);
  for (id node in nodes) {
    AXUIElementRef el = (__bridge AXUIElementRef)node;
    if (![str(el, kAXRoleAttribute) isEqual:@"AXScrollArea"])
      continue;
    NSValue *candidate = bounds(el);
    if (!candidate)
      continue;
    CGRect rect =
        CGRectIntersection(NSRectToCGRect(candidate.rectValue), windowFrame);
    if (rect.size.width / vw >= 0.5 && rect.size.width / vw <= 3 &&
        fabs(rect.size.width / vw - rect.size.height / vh) <= 0.02 &&
        CGRectIntersectsRect(content, rect)) {
      content = rect;
      break;
    }
  }
  double sx = content.size.width / vw, sy = content.size.height / vh;
  CGRect targetRect;
  if (!mapCssRect(content, CGRectMake(x, y, w, h), vw, vh, &targetRect))
    return @"native-viewport-scale-mismatch";
  CGPoint point =
      CGPointMake(CGRectGetMidX(targetRect), CGRectGetMidY(targetRect));
  CGDirectDisplayID displays[8];
  uint32_t count = 0;
  CGGetDisplaysWithPoint(point, 8, displays, &count);
  if (count != 1)
    return @"native-screen-ambiguous";
  CGRect screen = CGDisplayBounds(displays[0]);
  double backing = (double)CGDisplayPixelsWide(displays[0]) / screen.size.width;
  if (!CGRectContainsRect(screen, targetRect) ||
      fabs([v[@"dpr"] doubleValue] - backing * sx) > 0.15)
    return @"native-screen-scale-mismatch";
  AXUIElementRef hit = NULL, system = AXUIElementCreateSystemWide();
  AXError status =
      AXUIElementCopyElementAtPosition(system, point.x, point.y, &hit);
  CFRelease(system);
  if (status != kAXErrorSuccess || !hit)
    return @"native-hit-unavailable";
  pid_t hitPid = 0;
  AXUIElementGetPid(hit, &hitPid);
  NSString *title = str(hit, kAXTitleAttribute),
           *description = str(hit, kAXDescriptionAttribute),
           *role = str(hit, kAXRoleAttribute);
  NSString *label = [NSString stringWithFormat:@"%@ %@", title, description];
  if (hitPid != pid) {
    CFRelease(hit);
    return @"native-hit-other-application";
  }
  if ([label rangeOfString:@"支付|购买|下单|删除|授权|密码|登录"
                   options:NSRegularExpressionSearch]
          .location != NSNotFound) {
    CFRelease(hit);
    return @"sensitive-native-target";
  }
  NSValue *nativeHitFrame = bounds(hit);
  if (!nativeHitFrame ||
      !CGRectContainsPoint(NSRectToCGRect(nativeHitFrame.rectValue), point)) {
    CFRelease(hit);
    return @"native-hit-bounds-mismatch";
  }
  NSString *kind = target[@"kind"];
  CGRect nativeSliderFrame = CGRectNull;
  NSDictionary *control = proof[@"control"];
  if ([kind isEqual:@"return-to-list"] || [kind isEqual:@"refresh-list"]) {
    NSURLComponents *destination =
        [NSURLComponents componentsWithString:target[@"url"]];
    if (![destination.host isEqual:@"xyq.cbg.163.com"] ||
        ![@[ @"/cgi-bin/equipquery.py", @"/cgi-bin/xyq_overall_search.py" ]
            containsObject:destination.path] ||
        ([kind isEqual:@"refresh-list"] &&
         ![target[@"url"] isEqual:proof[@"url"]]))
      error = @"invalid-navigation-destination";
  } else if ([kind isEqual:@"market-entry"]) {
    NSDictionary *paths = @{
      @"equipment" : @"/cgi-bin/equipquery.py?act=show_overall_search_equip",
      @"pet" : @"/cgi-bin/equipquery.py?act=show_overall_search_pet",
      @"pet-gear" :
          @"/cgi-bin/xyq_overall_search.py?act=show_pet_equip_search_form",
      @"jewelry" :
          @"/cgi-bin/xyq_overall_search.py?act=show_overall_search_lingshi",
      @"yuanshen" :
          @"/cgi-bin/xyq_overall_search.py?act=show_overall_search_yuanshen",
      @"jade" : @"/cgi-bin/xyq_overall_search.py?act=show_overall_search_yupo"
    };
    NSURLComponents *link =
        [NSURLComponents componentsWithString:str(hit, CFSTR("AXURL"))];
    if (![link.host isEqual:@"xyq.cbg.163.com"] ||
        ![[NSString stringWithFormat:@"%@?%@", link.path, link.query]
            isEqual:paths[target[@"category"]]])
      error = @"native-market-entry-mismatch";
  } else if ([kind isEqual:@"scroll"]) {
    NSDictionary *toward = target[@"toward"],
                 *observed = proof[@"scrollTarget"], *r = observed[@"rect"];
    double delta = [target[@"deltaY"] doubleValue];
    if (![toward isKindOfClass:NSDictionary.class] ||
        ![toward isEqual:observed[@"semantic"]] || !isfinite(delta) ||
        fabs(delta) < 1 || fabs(delta) > MIN(vh * 0.65, 800))
      error = @"native-unbounded-scroll";
    CGRect expected = CGRectMake(content.origin.x + [r[@"x"] doubleValue] * sx,
                                 content.origin.y + [r[@"y"] doubleValue] * sy,
                                 [r[@"width"] doubleValue] * sx,
                                 [r[@"height"] doubleValue] * sy);
    NSString *targetKind = toward[@"kind"];
    NSInteger matches = 0;
    for (id node in nodes) {
      AXUIElementRef el = (__bridge AXUIElementRef)node;
      NSString *name = str(el, kAXTitleAttribute),
               *desc = str(el, kAXDescriptionAttribute),
               *identifier = str(el, CFSTR("AXDOMIdentifier"));
      bool semantic = false;
      if ([targetKind isEqual:@"listing-detail"]) {
        NSURLComponents *u =
            [NSURLComponents componentsWithString:str(el, CFSTR("AXURL"))];
        NSString *server = nil, *eid = nil;
        for (NSURLQueryItem *q in u.queryItems) {
          if ([q.name isEqual:@"s"])
            server = q.value;
          if ([q.name isEqual:@"eid"])
            eid = q.value;
        }
        semantic = [u.host isEqual:@"xyq.cbg.163.com"] &&
                   [u.path isEqual:@"/equip"] &&
                   [server isEqual:toward[@"serverId"]] &&
                   [eid isEqual:toward[@"eid"]];
      } else if ([@[
                   @"detail-tab", @"detail-subtab", @"detail-entry",
                   @"inspect-item"
                 ] containsObject:targetKind])
        semantic =
            [name isEqual:toward[@"name"]] || [desc isEqual:toward[@"name"]];
      else if ([@[ @"market-field", @"query-field" ] containsObject:targetKind])
        semantic = [identifier isEqual:toward[@"field"]];
      else if ([targetKind isEqual:@"next-page"])
        semantic = [name isEqual:@"下一页"] || [desc isEqual:@"下一页"];
      else if ([@[ @"jump-page", @"market-page" ] containsObject:targetKind])
        semantic = [name isEqual:[toward[@"page"] stringValue]];
      else if ([targetKind isEqual:@"market-reset"])
        semantic = [identifier isEqual:@"reset_all"];
      else if ([targetKind isEqual:@"market-reset-server"])
        semantic = [identifier isEqual:@"btn_reset_user_server"];
      else if ([targetKind isEqual:@"market-submit"])
        semantic = [identifier isEqual:observed[@"controlId"]] &&
                   [identifier hasPrefix:@"btn_"];
      else
        semantic = [name isEqual:observed[@"label"]] &&
                   [observed[@"label"] length] > 0;
      NSValue *candidate = semantic ? bounds(el) : nil;
      if (candidate &&
          CGRectIntersectsRect(NSRectToCGRect(candidate.rectValue), expected))
        matches++;
    }
    if (!matches || CGRectContainsRect(content, expected) ||
        (delta > 0 && CGRectGetMaxY(expected) <= CGRectGetMaxY(content)) ||
        (delta < 0 && CGRectGetMinY(expected) >= CGRectGetMinY(content)))
      error = @"native-scroll-target-unverified";
  } else if ([kind isEqual:@"market-level-handle"]) {
    NSDictionary *slider = proof[@"slider"];
    NSString *sliderId = [target[@"category"] isEqual:@"jewelry"]
                             ? @"equip_level_slider"
                             : @"level_slider";
    double requested = [target[@"value"] doubleValue],
           minimum = [slider[@"minimum"] doubleValue],
           maximum = [slider[@"maximum"] doubleValue],
           step = [slider[@"step"] doubleValue];
    if (![slider[@"id"] isEqual:sliderId] ||
        [slider[@"requested"] doubleValue] != requested ||
        !isfinite(requested + minimum + maximum + step) || step <= 0 ||
        requested < minimum || requested > maximum ||
        fmod(requested - minimum, step) != 0 ||
        ![@[ @"minimum", @"maximum" ] containsObject:target[@"handle"]])
      error = @"native-slider-plan-mismatch";
    AXUIElementRef ancestor = (AXUIElementRef)CFRetain(hit);
    for (int i = 0; i < 8 && ancestor; i++) {
      if ([str(ancestor, CFSTR("AXDOMIdentifier")) isEqual:sliderId]) {
        NSValue *b = bounds(ancestor);
        if (b)
          nativeSliderFrame = NSRectToCGRect(b.rectValue);
      }
      id parent = attr(ancestor, kAXParentAttribute);
      CFRelease(ancestor);
      ancestor =
          parent ? (AXUIElementRef)CFRetain((__bridge CFTypeRef)parent) : NULL;
    }
    if (ancestor)
      CFRelease(ancestor);
    NSDictionary *to = slider[@"to"];
    CGPoint end = CGPointMake(content.origin.x + [to[@"x"] doubleValue] * sx,
                              content.origin.y + [to[@"y"] doubleValue] * sy);
    NSString *current = [slider[@"current"] stringValue];
    if (CGRectIsNull(nativeSliderFrame) ||
        !CGRectContainsPoint(nativeSliderFrame, point) ||
        !CGRectContainsPoint(nativeSliderFrame, end) ||
        !CGRectContainsPoint(content, end) || !current.length ||
        [label rangeOfString:current].location == NSNotFound)
      error = @"native-slider-semantics-unverified";
  } else if ([kind isEqual:@"market-field"]) {
    NSString *domId = str(hit, CFSTR("AXDOMIdentifier"));
    if (![domId isEqual:target[@"field"]] || ![@[
          @"AXTextField", @"AXComboBox", @"AXPopUpButton", @"AXCheckBox",
          @"AXRadioButton"
        ] containsObject:role])
      error = @"native-market-field-mismatch";
  } else if ([kind isEqual:@"market-choice"]) {
    bool matched = false;
    AXUIElementRef ancestor = (AXUIElementRef)CFRetain(hit);
    for (int i = 0; i < 6 && ancestor; i++) {
      if ([str(ancestor, CFSTR("AXDOMIdentifier")) isEqual:target[@"panel"]])
        matched = true;
      id parent = attr(ancestor, kAXParentAttribute);
      CFRelease(ancestor);
      ancestor =
          parent ? (AXUIElementRef)CFRetain((__bridge CFTypeRef)parent) : NULL;
    }
    if (ancestor)
      CFRelease(ancestor);
    NSString *expected = control[@"label"];
    bool structuralStar = false;
    if ([target[@"panel"] isEqual:@"super_sum_star"]) {
      NSString *wanted = [target[@"values"] firstObject],
               *classes = control[@"className"];
      bool group = false;
      NSMutableArray *starPeers = nil;
      AXUIElementRef ancestor = (AXUIElementRef)CFRetain(hit);
      for (int i = 0; i < 7 && ancestor; i++) {
        NSString *groupLabel = [str(ancestor, kAXTitleAttribute)
            stringByAppendingString:str(ancestor, kAXDescriptionAttribute)];
        if ([groupLabel rangeOfString:@"神兽|星级|星"
                              options:NSRegularExpressionSearch]
                .location != NSNotFound)
          group = true;
        NSArray *descendants = tree(ancestor, 0);
        NSMutableArray *radios = [NSMutableArray array];
        for (id child in descendants) {
          AXUIElementRef element = (__bridge AXUIElementRef)child;
          NSString *r = str(element, kAXRoleAttribute);
          if ([@[ @"AXRadioButton", @"AXCheckBox" ] containsObject:r])
            [radios addObject:child];
          NSString *name = [str(element, kAXTitleAttribute)
              stringByAppendingString:str(element, kAXDescriptionAttribute)];
          if ([name rangeOfString:@"神兽|星级"
                          options:NSRegularExpressionSearch]
                  .location != NSNotFound)
            group = true;
        }
        if (radios.count == 4 && group) {
          starPeers = radios;
          break;
        }
        id parent = attr(ancestor, kAXParentAttribute);
        CFRelease(ancestor);
        ancestor = parent ? (AXUIElementRef)CFRetain((__bridge CFTypeRef)parent)
                          : NULL;
      }
      if (ancestor)
        CFRelease(ancestor);
      if (starPeers &&
          [control[@"starValues"] isEqual:@[ @"0", @"1", @"2", @"3" ]]) {
        [starPeers sortUsingComparator:^NSComparisonResult(id a, id b) {
          CGRect x = NSRectToCGRect(
                     bounds((__bridge AXUIElementRef)a).rectValue),
                 y = NSRectToCGRect(
                     bounds((__bridge AXUIElementRef)b).rectValue);
          double dy = CGRectGetMidY(x) - CGRectGetMidY(y),
                 dx = CGRectGetMidX(x) - CGRectGetMidX(y);
          return fabs(dy) > 4
                     ? (dy < 0 ? NSOrderedAscending : NSOrderedDescending)
                     : (dx < 0 ? NSOrderedAscending : NSOrderedDescending);
        }];
        NSInteger index = [control[@"starIndex"] integerValue];
        if (index >= 0 && index < 4 && index == wanted.integerValue) {
          NSValue *b = bounds((__bridge AXUIElementRef)starPeers[index]);
          structuralStar =
              b && CGRectContainsPoint(NSRectToCGRect(b.rectValue), point);
        }
      }
      matched =
          group && [@[ @"0", @"1", @"2", @"3" ] containsObject:wanted] &&
          [control[@"value"] isEqual:wanted] &&
          [classes isKindOfClass:NSString.class] &&
          [[classes
              componentsSeparatedByCharactersInSet:NSCharacterSet
                                                       .whitespaceCharacterSet]
              containsObject:@"js_super_sum_star"] &&
          [@[ @"AXCheckBox", @"AXRadioButton" ] containsObject:role];
    }
    if (!matched ||
        (!structuralStar &&
         (![expected isKindOfClass:NSString.class] || !expected.length ||
          [label rangeOfString:expected].location == NSNotFound)))
      error = @"native-market-choice-mismatch";
  } else if ([@[
               @"market-reset", @"market-reset-server", @"market-expand", @"market-submit",
               @"market-page"
             ] containsObject:kind]) {
    NSString *expectedId = control[@"id"];
    NSString *domId = str(hit, CFSTR("AXDOMIdentifier"));
    if (![expectedId isKindOfClass:NSString.class] || !expectedId.length ||
        ![domId isEqual:expectedId])
      error = @"native-market-control-mismatch";
  } else if ([kind isEqual:@"sort"]) {
    NSString *expected =
        [target[@"value"] componentsSeparatedByString:@" "].firstObject;
    if ([expected isEqual:@"selling_time"])
      expected = @"上架";
    else if ([expected isEqual:@"expire_time"])
      expected = @"到期";
    if (![@[ @"初防", @"初伤", @"初灵", @"初血", @"初敏", @"上架", @"到期" ]
            containsObject:expected] ||
        [label rangeOfString:expected].location == NSNotFound)
      error = @"native-sort-semantic-mismatch";
  } else if ([kind isEqual:@"listing-detail"]) {
    NSMutableArray *links = [NSMutableArray arrayWithObject:(__bridge id)hit];
    id parent = attr(hit, kAXParentAttribute);
    if (parent)
      [links addObject:parent];
    bool found = false;
    for (id node in links) {
      NSURLComponents *u = [NSURLComponents
          componentsWithString:str((__bridge AXUIElementRef)node,
                                   CFSTR("AXURL"))];
      if (![u.host isEqual:@"xyq.cbg.163.com"] || ![u.path isEqual:@"/equip"])
        continue;
      NSString *server = nil, *eid = nil;
      for (NSURLQueryItem *query in u.queryItems) {
        if ([query.name isEqual:@"s"])
          server = query.value;
        if ([query.name isEqual:@"eid"])
          eid = query.value;
      }
      found =
          [server isEqual:target[@"serverId"]] && [eid isEqual:target[@"eid"]];
      if (found)
        break;
    }
    if (!found)
      error = @"native-detail-semantic-mismatch";
  } else if ([kind isEqual:@"next-page"]) {
    if (![title isEqual:@"下一页"] && ![description isEqual:@"下一页"])
      error = @"native-next-page-semantic-mismatch";
  } else if ([@[
               @"detail-tab", @"detail-subtab", @"detail-entry", @"inspect-item"
             ] containsObject:kind]) {
    NSString *name = target[@"name"];
    if (![name isKindOfClass:NSString.class] || !name.length ||
        [label rangeOfString:name].location == NSNotFound)
      error = @"native-target-semantic-mismatch";
  } else if ([kind isEqual:@"query"]) {
    if ([label rangeOfString:@"搜索|查询" options:NSRegularExpressionSearch]
            .location == NSNotFound)
      error = @"native-query-semantic-mismatch";
  } else if ([@[ @"jump-page", @"query-field" ] containsObject:kind]) {
    NSString *pattern = [kind isEqual:@"jump-page"] ? @"页"
                        : [target[@"field"] containsString:@"price"]
                            ? @"价格|价"
                            : @"等级|级";
    if ([kind isEqual:@"jump-page"] && [role isEqual:@"AXLink"] &&
        [title isEqual:[target[@"page"] stringValue]]) {
    } else if (![role isEqual:@"AXTextField"] ||
               [label rangeOfString:pattern options:NSRegularExpressionSearch]
                       .location == NSNotFound)
      error = @"native-field-semantic-unverified";
  } else
    error = @"unsupported-native-target";
  CFRelease(hit);
  if (error)
    return error;
  IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep,
                              kIOPMAssertionLevelOn,
                              CFSTR("CBG authorized input"), &awake);
  if ([kind isEqual:@"return-to-list"] || [kind isEqual:@"refresh-list"]) {
    error = key([kind isEqual:@"refresh-list"]
                    ? 15
                    : ([proof[@"ownedChildTab"] boolValue] ? 13 : 33),
                kCGEventFlagMaskCommand);
    releaseAwake();
    return error;
  }
  error = post(CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, point,
                                       kCGMouseButtonLeft));
  if ([kind isEqual:@"scroll"]) {
    if (!error)
      error = post(CGEventCreateScrollWheelEvent(
          NULL, kCGScrollEventUnitPixel, 1,
          (int32_t)-round([target[@"deltaY"] doubleValue] * sy)));
    releaseAwake();
    return error;
  }
  if (!error && ![kind isEqual:@"inspect-item"]) {
    error = post(CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, point,
                                         kCGMouseButtonLeft));
    if (error || ![kind isEqual:@"market-level-handle"])
      releaseButton(point);
  }
  if (!error && [kind isEqual:@"market-level-handle"]) {
    NSDictionary *to = proof[@"slider"][@"to"];
    CGPoint end = CGPointMake(content.origin.x + [to[@"x"] doubleValue] * sx,
                              content.origin.y + [to[@"y"] doubleValue] * sy);
    // The initial mouse-down above owns the drag; every exit releases it.
    for (int i = 1; i <= 8 && !error; i++) {
      CGPoint next = CGPointMake(point.x + (end.x - point.x) * i / 8,
                                 point.y + (end.y - point.y) * i / 8);
      error = post(CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDragged, next,
                                           kCGMouseButtonLeft));
      usleep(15000);
    }
    releaseButton(end);
  }
  if (error && [kind isEqual:@"market-level-handle"])
    releaseButton(point);
  if (!error && [kind isEqual:@"jump-page"] &&
      ![control[@"tagName"] isEqual:@"A"]) {
    error = inputText([target[@"page"] stringValue], true);
    if (!error)
      error = key(36, 0);
  }
  if (!error && [kind isEqual:@"query-field"])
    error = inputText(target[@"value"], true);
  if (!error && [kind isEqual:@"market-field"]) {
    NSString *type = control[@"type"], *tag = control[@"tagName"];
    if ([tag isEqual:@"SELECT"]) {
      NSInteger option = [control[@"optionIndex"] integerValue];
      if (option < 0 || option > 200)
        error = @"native-option-range";
      else {
        error = key(115, 0);
        for (NSInteger i = 0; i < option && !error; i++)
          error = key(125, 0);
        if (!error)
          error = key(36, 0);
      }
    } else if (![@[ @"checkbox", @"radio" ] containsObject:type])
      error = inputText(target[@"value"], false);
  }
  releaseAwake();
  return error ?: check();
}
static CGEventRef tapCallback(CGEventTapProxy proxy, CGEventType type,
                              CGEventRef event, void *refcon) {
  if (type == kCGEventTapDisabledByTimeout ||
      type == kCGEventTapDisabledByUserInput) {
    tapReady = false;
    preempted = true;
    return event;
  }
  if (CGEventGetIntegerValueField(event, kCGEventSourceUserData) != marker)
    preempted = true;
  return event;
}
static void writeResult(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value
                                                 options:NSJSONWritingSortedKeys
                                                   error:NULL];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}
int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc > 1 && strcmp(argv[1], "--self-test") == 0) {
      CGRect mapped, content = CGRectMake(-1400, 80, 1200, 800),
                     css = CGRectMake(10, 20, 30, 40);
      if (!mapCssRect(content, css, 1200, 800, &mapped) ||
          mapped.origin.x != -1390 || mapped.origin.y != 100)
        return 1;
      if (!mapCssRect(content, css, 600, 400, &mapped) ||
          mapped.size.width != 60 || mapped.origin.x != -1380)
        return 1;
      if (!mapCssRect(content, css, 2400, 1600, &mapped) ||
          mapped.size.width != 15)
        return 1;
      if (mapCssRect(content, css, 600, 800, &mapped) ||
          mapCssRect(content, CGRectMake(-1, 0, 20, 20), 1200, 800, &mapped) ||
          mapCssRect(content, CGRectMake(1190, 0, 20, 20), 1200, 800,
                     &mapped) ||
          mapCssRect(content, css, 0, 800, &mapped) ||
          mapCssRect(content, CGRectMake(NAN, 0, 20, 20), 1200, 800, &mapped))
        return 1;
      DesktopGuard ready = {false, false, true, true, true, false, true};
      if (guardFailure(ready))
        return 1;
      DesktopGuard variants[7] = {ready, ready, ready, ready,
                                  ready, ready, ready};
      variants[0].stopped = true;
      variants[1].preempted = true;
      variants[2].tapReady = false;
      variants[3].accessibility = false;
      variants[4].inputMonitoring = false;
      variants[5].locked = true;
      variants[6].chromeForeground = false;
      for (int index = 0; index < 7; index++)
        if (!guardFailure(variants[index]))
          return 1;
      if (monitorState(true, false) || monitorState(false, true) ||
          !monitorState(true, true))
        return 1;
      puts("native coordinate and desktop-guard self-tests passed (19 "
           "assertions, no input posted)");
      return 0;
    }
    signal(SIGUSR1, emergencyStop);
    writeResult(@{@"kind" : @"input-ready", @"version" : @1});
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      CGEventMask mask = CGEventMaskBit(kCGEventMouseMoved) |
                         CGEventMaskBit(kCGEventLeftMouseDown) |
                         CGEventMaskBit(kCGEventRightMouseDown) |
                         CGEventMaskBit(kCGEventKeyDown) |
                         CGEventMaskBit(kCGEventScrollWheel);
      CFMachPortRef tap = CGEventTapCreate(
          kCGSessionEventTap, kCGHeadInsertEventTap,
          kCGEventTapOptionListenOnly, mask, tapCallback, NULL);
      if (!tap) {
        stopped = true;
        return;
      }
      CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(NULL, tap, 0);
      CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
      CGEventTapEnable(tap, true);
      pthread_mutex_lock(&monitorLock);
      activeMonitorTap = tap;
      pthread_mutex_unlock(&monitorLock);
      tapReady = CGEventTapIsEnabled(tap);
      CFRunLoopRun();
      tapReady = false;
      pthread_mutex_lock(&monitorLock);
      activeMonitorTap = NULL;
      pthread_mutex_unlock(&monitorLock);
      CFRelease(source);
      CFRelease(tap);
    });
    char *line = NULL;
    size_t capacity = 0;
    ssize_t length;
    while ((length = getline(&line, &capacity, stdin)) > 0) {
      @autoreleasepool {
        @try {
          if (length > 512 * 1024) {
            writeResult(@{@"ok" : @NO, @"error" : @"command-size"});
            continue;
          }
          NSDictionary *request = [NSJSONSerialization
              JSONObjectWithData:[NSData dataWithBytes:line length:length]
                         options:0
                           error:NULL];
          if (![request isKindOfClass:NSDictionary.class]) {
            writeResult(@{@"ok" : @NO, @"error" : @"invalid-command"});
            continue;
          }
          NSString *command=request[@"command"], *actionId=request[@"actionId"] ?: request[@"plan"][@"actionId"] ?: @"";
          if ([command isEqual:@"status"])
            writeResult(@{
              @"ok" : @YES,
              @"actionId" : actionId,
              @"permissions" : @{
                @"accessibility" : @(AXIsProcessTrusted()),
                @"inputMonitoring" : @(CGPreflightListenEventAccess()),
                @"inputMonitorActive" : @(inputMonitorActive()),
                @"screenRecording" : @(CGPreflightScreenCaptureAccess()),
                @"locked" : @(locked()),
                @"frontmostChrome" :
                    @([NSWorkspace.sharedWorkspace.frontmostApplication
                            .bundleIdentifier isEqual:@"com.google.Chrome"])
              }
            });
          else if ([command isEqual:@"stop"]) {
            if ([request[@"hostInstanceEpoch"] isEqual:acceptedHostInstance] &&
                [request[@"hostGeneration"] unsignedLongLongValue] >
                    acceptedGeneration)
              acceptedGeneration =
                  [request[@"hostGeneration"] unsignedLongLongValue];
            stopped = true;
            releaseAwake();
            writeResult(@{@"ok" : @YES, @"actionId" : actionId});
          } else if ([command isEqual:@"resume"]) {
            NSString *instance = request[@"hostInstanceEpoch"],
                     *session = request[@"browserSessionEpoch"];
            uint64_t generation =
                [request[@"hostGeneration"] unsignedLongLongValue];
            int64_t epoch = [request[@"stopEpoch"] longLongValue];
            if (![instance isKindOfClass:NSString.class] ||
                ![session isKindOfClass:NSString.class] || !instance.length ||
                !session.length || generation < acceptedGeneration ||
                epoch < acceptedStopEpoch ||
                (acceptedHostInstance && ![acceptedHostInstance
                                             isEqual:instance])) {
              stopped = true;
              writeResult(@{
                @"ok" : @NO,
                @"actionId" : actionId,
                @"error" : @"invalid-native-resume-authority"
              });
            } else if (!inputMonitorActive()) {
              stopped = true;
              writeResult(@{
                @"ok" : @NO,
                @"actionId" : actionId,
                @"error" : @"input-monitor-disabled-restart-host"
              });
            } else {
              acceptedHostInstance = instance;
              acceptedSessionEpoch = session;
              acceptedGeneration = generation;
              acceptedStopEpoch = epoch;
              stopped = false;
              preempted = false;
              writeResult(@{@"ok" : @YES, @"actionId" : actionId});
            }
          } else if ([command isEqual:@"execute"]) {
            postedAny = false;
            NSString *error = validateAndExecute(request);
            writeResult(error ? @{
              @"ok" : @NO,
              @"actionId" : actionId,
              @"error" : error,
              @"posted" : @(postedAny)
            }
                              : @{
                                  @"ok" : @YES,
                                  @"actionId" : actionId,
                                  @"state" : @"input_posted_result_unconfirmed",
                                  @"posted" : @(postedAny),
                                  @"scrollFromY" :
                                          request[@"proof"][@"scrollTarget"]
                                                 [@"rect"][@"y"]
                                      ?: @0
                                });
          } else
            writeResult(@{
              @"ok" : @NO,
              @"actionId" : actionId,
              @"error" : @"unsupported-command"
            });
        } @catch (NSException *exception) {
          stopped = true;
          releaseAwake();
          writeResult(@{@"ok" : @NO, @"error" : @"native-invalid-command"});
        }
      }
    }
    free(line);
    releaseAwake();
    return 0;
  }
}
