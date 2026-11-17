#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <mach/mach_time.h>

#ifndef CBG_INPUT_STARTUP_TIMEOUT_MS
#define CBG_INPUT_STARTUP_TIMEOUT_MS 5000
#endif
// Compile-only monitor backend for protocol/startup regressions. It never posts OS input.
#ifdef CBG_INPUT_TEST_MONITOR
#ifndef CBG_INPUT_TEST_MONITOR_DELAY_MS
#define CBG_INPUT_TEST_MONITOR_DELAY_MS 0
#endif
#ifndef CBG_INPUT_TEST_MONITOR_READY
#define CBG_INPUT_TEST_MONITOR_READY 1
#endif
#define CGEventPost(...) ((void)0)
#endif

static const int64_t marker = 0x43424741;
static _Atomic bool stopped = false, preempted = false, tapReady = false, ownsInput = false;
_Static_assert(ATOMIC_LLONG_LOCK_FREE == 2 && ATOMIC_INT_LOCK_FREE == 2 && ATOMIC_BOOL_LOCK_FREE == 2,
  "event tap diagnostics require lock-free atomics");
static mach_timebase_info_data_t inputTimebase;
static _Atomic uint64_t inputGrantAtNs = 0, inputGrantEpoch = 0;
static _Atomic uint64_t grantPointerXBits = 0, grantPointerYBits = 0;
static _Atomic bool grantPointerAvailable = false;
static _Atomic unsigned preemptionRecordState = 0, firstPreemptionType = 0;
static _Atomic uint64_t firstEventAtNs = 0, firstCallbackAtNs = 0, firstGrantAtNs = 0, firstGrantEpoch = 0;
static _Atomic int64_t firstSourcePid = 0, firstUserData = 0;
static _Atomic int64_t firstSourceStateID = 0, firstMouseDeltaX = 0, firstMouseDeltaY = 0;
static _Atomic uint64_t firstMouseXBits = 0, firstMouseYBits = 0, firstGrantPointerXBits = 0, firstGrantPointerYBits = 0;
static _Atomic bool firstOwnedInput = false, firstTapDisabled = false;
static _Atomic bool firstHasMouse = false, firstMouseLocationAvailable = false, firstGrantPointerAvailable = false;
_Static_assert(sizeof(double) == sizeof(uint64_t), "diagnostic coordinates use lock-free uint64 bit storage");
static uint64_t coordinateBits(double value) {
  union { double coordinate; uint64_t bits; } storage = {.coordinate = value};
  return storage.bits;
}
static double coordinateValue(uint64_t bits) {
  union { double coordinate; uint64_t bits; } storage = {.bits = bits};
  return storage.coordinate;
}
typedef struct {
  uint32_t type;
  uint64_t timestampNs;
  int64_t sourcePid, userData, sourceStateID, deltaX, deltaY;
  CGPoint location;
  bool hasMouse, locationAvailable;
} InputEventMetadata;
static uint64_t inputAbsoluteNs(void) {
  return (uint64_t)((__uint128_t)mach_absolute_time() * inputTimebase.numer / inputTimebase.denom);
}
static NSDictionary *inputPreemptionDiagnostic(void) {
  if (atomic_load_explicit(&preemptionRecordState, memory_order_acquire) != 2) return @{};
  NSMutableDictionary *value = [@{@"diagnosticSchema": @2,
    @"recordScope": @"first-preemption-in-helper-process", @"helperPid": @(getpid()),
    @"eventType": @(atomic_load(&firstPreemptionType)),
    @"eventTimestampNs": [NSString stringWithFormat:@"%llu", (unsigned long long)atomic_load(&firstEventAtNs)],
    @"callbackTimestampNs": [NSString stringWithFormat:@"%llu", (unsigned long long)atomic_load(&firstCallbackAtNs)],
    @"grantTimestampNs": [NSString stringWithFormat:@"%llu", (unsigned long long)atomic_load(&firstGrantAtNs)],
    @"authorizationEpoch": @(atomic_load(&firstGrantEpoch)),
    @"sourcePid": @(atomic_load(&firstSourcePid)), @"userData": @(atomic_load(&firstUserData)),
    @"sourceStateID": @(atomic_load(&firstSourceStateID)),
    @"ownsInput": @(atomic_load(&firstOwnedInput)), @"tapDisabled": @(atomic_load(&firstTapDisabled)),
    @"coordinateSource": @"CGEventGetLocation-global-display-coordinates",
    @"deltaSource": @"kCGMouseEventDeltaX/Y-since-prior-mouse-movement",
    @"grantPointerAvailable": @(atomic_load(&firstGrantPointerAvailable))} mutableCopy];
  if (atomic_load(&firstGrantPointerAvailable))
    value[@"grantPointer"] = @{@"x": @(coordinateValue(atomic_load(&firstGrantPointerXBits))),
      @"y": @(coordinateValue(atomic_load(&firstGrantPointerYBits)))};
  if (atomic_load(&firstHasMouse)) {
    NSMutableDictionary *mouse = [@{@"deltaX": @(atomic_load(&firstMouseDeltaX)),
      @"deltaY": @(atomic_load(&firstMouseDeltaY)),
      @"locationAvailable": @(atomic_load(&firstMouseLocationAvailable))} mutableCopy];
    if (atomic_load(&firstMouseLocationAvailable))
      mouse[@"location"] = @{@"x": @(coordinateValue(atomic_load(&firstMouseXBits))),
        @"y": @(coordinateValue(atomic_load(&firstMouseYBits)))};
    value[@"mouse"] = mouse;
  }
  return value;
}
static bool postedAny = false;
static double proofDeadline = 0;
static uint64_t acceptedGeneration = 0;
static int64_t acceptedStopEpoch = -1;
static NSString *acceptedSessionEpoch = nil, *acceptedHostInstance = nil;
static pthread_mutex_t activityLock = PTHREAD_MUTEX_INITIALIZER;
static NSDictionary *activeActivity = nil;
static uint64_t highestActivityEpoch = 0;
static double activityDeadline = 0, progressDeadline = 0;
static CGDirectDisplayID activityDisplay = kCGNullDirectDisplay;
static NSString *lastPostedAction = nil;
static NSMutableSet *creditedActions;
static void writeResult(NSDictionary *value);
static double monotonicMs(void) {
  static mach_timebase_info_data_t timebase;
  if (!timebase.denom) mach_timebase_info(&timebase);
  return (double)mach_continuous_time() * timebase.numer / timebase.denom / 1000000.0;
}
static bool timely(double now, double lease, double progress) { return now < lease && now < progress; }
static bool displayAvailable(CGDirectDisplayID display) {
  return display != kCGNullDirectDisplay && CGDisplayIsOnline(display) && CGDisplayIsActive(display) && !CGDisplayIsAsleep(display);
}
static CGDirectDisplayID displayAt(CGPoint point) {
  CGDirectDisplayID displays[32]; uint32_t count = 0;
  if (CGGetActiveDisplayList(32, displays, &count) != kCGErrorSuccess) return kCGNullDirectDisplay;
  for (uint32_t index = 0; index < count; index++)
    if (displayAvailable(displays[index]) && CGRectContainsPoint(CGDisplayBounds(displays[index]), point)) return displays[index];
  return kCGNullDirectDisplay;
}
static bool anyDisplay(void) {
  CGDirectDisplayID displays[32]; uint32_t count = 0;
  if (CGGetActiveDisplayList(32, displays, &count) != kCGErrorSuccess) return false;
  for (uint32_t index = 0; index < count; index++) if (displayAvailable(displays[index])) return true;
  return false;
}
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
#ifdef CBG_INPUT_TEST_MONITOR
  return monitorState(tapReady, tapReady);
#else
  pthread_mutex_lock(&monitorLock);
  CFMachPortRef tap = activeMonitorTap;
  if (tap)
    CFRetain(tap);
  pthread_mutex_unlock(&monitorLock);
  bool enabled = tap && CGEventTapIsEnabled(tap);
  if (tap)
    CFRelease(tap);
  return monitorState(tapReady, enabled);
#endif
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
      chromeForeground, displayAvailable;
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
  if (!state.displayAvailable) return @"display-unavailable";
  return nil;
}
static NSString *check(void) {
  return guardFailure((DesktopGuard){
      stopped, preempted, inputMonitorActive(), AXIsProcessTrusted(),
      CGPreflightListenEventAccess(), locked(),
      [NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier
          isEqual:@"com.google.Chrome"], anyDisplay()});
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
typedef struct {
  double pointWidth, pointHeight, pixelWidth, pixelHeight, rotation;
} NativeDisplayMode;
static bool displayScaleMatches(CGSize desktop, NativeDisplayMode mode,
                                double cssScale, double dpr) {
  if (!isfinite(desktop.width + desktop.height + mode.pointWidth + mode.pointHeight +
      mode.pixelWidth + mode.pixelHeight + mode.rotation + cssScale + dpr) ||
      desktop.width <= 0 || desktop.height <= 0 || mode.pointWidth <= 0 ||
      mode.pointHeight <= 0 || mode.pixelWidth <= 0 || mode.pixelHeight <= 0 ||
      cssScale <= 0 || dpr <= 0 || fabs(mode.rotation) > 0.001 ||
      fabs(desktop.width - mode.pointWidth) > 0.5 ||
      fabs(desktop.height - mode.pointHeight) > 0.5) return false;
  // Use pixel/point dimensions from the same mode, never mix rotated axes.
  double backingX = mode.pixelWidth / mode.pointWidth,
         backingY = mode.pixelHeight / mode.pointHeight;
  return isfinite(backingX + backingY) && fabs(backingX - backingY) <= 0.02 &&
    fabs(dpr - backingX * cssScale) <= 0.15;
}
// Lifecycle callers hold activityLock. The event tap only reads this atomic
// mirror and never waits for lifecycle system calls or touches Objective-C state.
static void publishInputOwnership(void) {
  bool granted = activeActivity != nil;
  if (granted) {
    atomic_store(&inputGrantEpoch, [activeActivity[@"authorizationEpoch"] unsignedLongLongValue]);
    atomic_store(&inputGrantAtNs, inputAbsoluteNs());
  }
  atomic_store_explicit(&ownsInput, granted, memory_order_release);
}
static void captureGrantPointer(void) {
  // Ordinary grant thread only. A snapshot is read, never posted or modified.
  CGEventRef snapshot = CGEventCreate(NULL);
  CGPoint point = snapshot ? CGEventGetLocation(snapshot) : CGPointZero;
  bool available = snapshot && isfinite(point.x + point.y);
  atomic_store(&grantPointerXBits, coordinateBits(point.x));
  atomic_store(&grantPointerYBits, coordinateBits(point.y));
  atomic_store(&grantPointerAvailable, available);
  if (snapshot) CFRelease(snapshot);
}
static void releaseInputOwnership(void) {
  atomic_store_explicit(&ownsInput, false, memory_order_release);
}
static void invalidateActivityFor(NSDictionary *expected, NSString *reason, bool notify) {
  pthread_mutex_lock(&activityLock);
  if (expected && (!activeActivity || ![expected[@"activityId"] isEqual:activeActivity[@"activityId"]] ||
    ![expected[@"authorizationEpoch"] isEqual:activeActivity[@"authorizationEpoch"]])) { pthread_mutex_unlock(&activityLock); return; }
  NSString *activityId = activeActivity[@"activityId"];
  NSDictionary *invalidated = activeActivity;
  activeActivity = nil;
  activityDeadline = progressDeadline = 0;
  activityDisplay = kCGNullDirectDisplay;
  releaseInputOwnership();
  pthread_mutex_unlock(&activityLock);
  stopped = true;
  if (notify && activityId) writeResult(@{@"kind": @"activity-invalidated", @"activityId": activityId,
    @"authorizationEpoch": invalidated[@"authorizationEpoch"], @"stopEpoch": invalidated[@"stopEpoch"],
    @"browserSessionEpoch": invalidated[@"browserSessionEpoch"], @"hostGeneration": invalidated[@"hostGeneration"],
    @"hostInstanceEpoch": invalidated[@"hostInstanceEpoch"], @"reason": reason,
    @"inputPreemption": inputPreemptionDiagnostic()});
}
static void invalidateActivity(NSString *reason, bool notify) { invalidateActivityFor(nil, reason, notify); }
static NSDictionary *activityStatus(void) {
  pthread_mutex_lock(&activityLock);
  NSDictionary *value = @{@"active": @((bool)(activeActivity && ownsInput && !stopped && !preempted &&
      timely(monotonicMs(), activityDeadline, progressDeadline))), @"lease": activeActivity ?: @{},
    @"expired": @((bool)(activeActivity && !timely(monotonicMs(), activityDeadline, progressDeadline)))};
  pthread_mutex_unlock(&activityLock);
  return value;
}
static bool sameActivity(NSDictionary *lease) {
  return activeActivity && [lease[@"activityId"] isEqual:activeActivity[@"activityId"]] &&
    [lease[@"authorizationEpoch"] isEqual:activeActivity[@"authorizationEpoch"]] &&
    [lease[@"stopEpoch"] longLongValue] == acceptedStopEpoch && [lease[@"browserSessionEpoch"] isEqual:acceptedSessionEpoch];
}
static NSString *activityFailure(NSDictionary *lease) {
  pthread_mutex_lock(&activityLock);
  NSString *error = !sameActivity(lease) || !ownsInput ? @"native-workflow-activity-required" :
    !timely(monotonicMs(), activityDeadline, progressDeadline) ? @"native-workflow-activity-expired" : nil;
  pthread_mutex_unlock(&activityLock);
  return error;
}
static void checkActivityWatchdog(NSDictionary *lease, bool expired,
    CGDirectDisplayID display, NSString *(^checkDesktop)(void),
    bool (^checkDisplay)(CGDirectDisplayID),
    void (^invalidate)(NSDictionary *, NSString *)) {
  if (!lease) return;
  // An already-expired lease must lose authority before any WindowServer query.
  if (expired) { invalidate(lease, @"native-workflow-activity-expired"); return; }
  NSString *failure = checkDesktop();
  if (failure || (display && !checkDisplay(display)))
    invalidate(lease, failure ?: @"activity-display-unavailable");
}
static NSString *activityCommand(NSDictionary *request) {
  NSDictionary *lease = request[@"activity"];
  if (![lease isKindOfClass:NSDictionary.class] || ![request[@"hostInstanceEpoch"] isEqual:acceptedHostInstance] ||
    [request[@"hostGeneration"] unsignedLongLongValue] != acceptedGeneration ||
    [lease[@"stopEpoch"] longLongValue] != acceptedStopEpoch || ![lease[@"browserSessionEpoch"] isEqual:acceptedSessionEpoch]) return @"stale-native-activity-authority";
  NSString *command = request[@"command"], *identifier = lease[@"activityId"];
  if (![identifier isKindOfClass:NSString.class] || [identifier rangeOfString:@"^[a-zA-Z0-9_-]{1,100}$" options:NSRegularExpressionSearch].location == NSNotFound) return @"invalid-native-activity-id";
  pthread_mutex_lock(&activityLock);
  NSString *error = nil;
  if ([command isEqual:@"activity-end"]) {
    if (!sameActivity(lease)) error = @"stale-native-activity-end";
    else { activeActivity = nil; activityDeadline = progressDeadline = 0; releaseInputOwnership(); }
  } else {
    double now = NSDate.date.timeIntervalSince1970 * 1000;
    double ttl = [lease[@"expiresAt"] doubleValue] - now, progress = [lease[@"progressExpiresAt"] doubleValue] - now;
    uint64_t epoch = [lease[@"authorizationEpoch"] unsignedLongLongValue];
    if (!isfinite(ttl + progress) || ttl <= 0 || ttl > 15000 || progress <= 0 || progress > 180000) error = @"invalid-native-activity-expiry";
    else if ([command isEqual:@"activity-begin"]) {
      if (activeActivity || !epoch || epoch <= highestActivityEpoch) error = @"stale-or-busy-native-activity";
      else if ((error = check())) {}
      else {
        captureGrantPointer();
        double grantedAt = NSDate.date.timeIntervalSince1970 * 1000;
        if (stopped || preempted || [lease[@"expiresAt"] doubleValue] <= grantedAt || [lease[@"progressExpiresAt"] doubleValue] <= grantedAt) {
          error = @"native-workflow-activity-grant-failed";
        } else {
          highestActivityEpoch = epoch;
          NSMutableDictionary *saved = [lease mutableCopy]; saved[@"hostGeneration"] = @(acceptedGeneration); saved[@"hostInstanceEpoch"] = acceptedHostInstance; activeActivity = [saved copy];
          activityDeadline = monotonicMs() + [lease[@"expiresAt"] doubleValue] - grantedAt;
          progressDeadline = monotonicMs() + [lease[@"progressExpiresAt"] doubleValue] - grantedAt;
          activityDisplay = kCGNullDirectDisplay; lastPostedAction = nil; creditedActions = [NSMutableSet new];
          publishInputOwnership();
        }
      }
    } else if ([command isEqual:@"activity-renew"]) {
      if (!sameActivity(lease) || !ownsInput || !timely(monotonicMs(), activityDeadline, progressDeadline)) error = @"stale-native-activity-renewal";
      else {
        NSInteger sequence = [lease[@"progressSequence"] integerValue], prior = [activeActivity[@"progressSequence"] integerValue];
        if (sequence == prior && ![lease[@"progressExpiresAt"] isEqual:activeActivity[@"progressExpiresAt"]]) error = @"heartbeat-cannot-extend-progress";
        else if (sequence != prior && (sequence != prior + 1 || ![lease[@"progressActionId"] isEqual:lastPostedAction] || [creditedActions containsObject:lease[@"progressActionId"]])) error = @"unverified-native-activity-progress";
        else {
          if (sequence != prior) { [creditedActions addObject:lease[@"progressActionId"]]; progressDeadline = monotonicMs() + progress; }
          NSMutableDictionary *saved = [lease mutableCopy]; saved[@"hostGeneration"] = @(acceptedGeneration); saved[@"hostInstanceEpoch"] = acceptedHostInstance; activeActivity = [saved copy]; activityDeadline = monotonicMs() + ttl;
        }
      }
    } else error = @"unsupported-activity-command";
  }
  pthread_mutex_unlock(&activityLock);
  return error;
}
static NSString *post(CGEventRef event) {
  NSString *error = check();
  if (!error) { pthread_mutex_lock(&activityLock); error = !activeActivity || !ownsInput || !timely(monotonicMs(), activityDeadline, progressDeadline) ? @"native-workflow-activity-expired" : nil; pthread_mutex_unlock(&activityLock); }
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
static bool queryFieldValueAllowed(NSString *field, NSString *value) {
  if (![value isKindOfClass:NSString.class] || ![@[@"price_min", @"price_max", @"level_min", @"level_max"] containsObject:field]) return false;
  NSString *pattern = [field hasPrefix:@"price_"] ? @"^(?:[0-9]{1,8}(?:\\.[0-9]{1,2})?)?$" : @"^(?:[0-9]{1,8})?$";
  return [value rangeOfString:pattern options:NSRegularExpressionSearch].location != NSNotFound;
}
static bool completeTextSelection(NSString *value, CFRange range) {
  return [value isKindOfClass:NSString.class] && range.location == 0 &&
    range.length >= 0 && (NSUInteger)range.length == value.length;
}
static bool unchangedTextFrame(CGRect expected, CGRect actual) {
  return isfinite(actual.origin.x + actual.origin.y + actual.size.width + actual.size.height) &&
    actual.size.width > 0 && actual.size.height > 0 &&
    fabs(expected.origin.x - actual.origin.x) <= 0.5 &&
    fabs(expected.origin.y - actual.origin.y) <= 0.5 &&
    fabs(expected.size.width - actual.size.width) <= 0.5 &&
    fabs(expected.size.height - actual.size.height) <= 0.5;
}
static NSString *textInputGuard(NSDictionary *request, pid_t expectedPid) {
  NSString *error = check();
  if (error) return error;
  if (!authorityMatches(request)) return @"stale-native-dispatch-generation";
  error = activityFailure(request[@"plan"][@"activity"]);
  if (error) return error;
  double now = NSDate.date.timeIntervalSince1970 * 1000;
  if (proofDeadline <= 0 || now < [request[@"proof"][@"sampledAt"] doubleValue] || now > proofDeadline)
    return @"target-proof-expired-before-input";
  if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != expectedPid)
    return @"native-text-application-changed";
  return nil;
}
static NSString *pageInputGuard(NSDictionary *request, pid_t expectedPid) {
  if (!authorityMatches(request)) return @"stale-native-dispatch-generation";
  NSString *error = activityFailure(request[@"plan"][@"activity"]);
  if (error) return error;
  double now = NSDate.date.timeIntervalSince1970 * 1000;
  if (now < [request[@"proof"][@"sampledAt"] doubleValue] || now >= proofDeadline)
    return @"target-proof-expired-before-input";
  error = check();
  if (error) return error;
  if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != expectedPid)
    return @"native-page-application-changed";
  // Desktop queries can themselves take time; recheck local authority afterwards.
  if (!authorityMatches(request)) return @"stale-native-dispatch-generation";
  error = activityFailure(request[@"plan"][@"activity"]);
  if (error) return error;
  now = NSDate.date.timeIntervalSince1970 * 1000;
  if (now < [request[@"proof"][@"sampledAt"] doubleValue] || now >= proofDeadline)
    return @"target-proof-expired-before-input";
  return stopped || preempted ? @"input-stopped-or-user-preempted" : nil;
}
// Readiness retries never create a new proof or dispatch. These callbacks also let
// pure regressions exercise the exact traversal without accessing another app.
typedef id (^PageAXRead)(id element, CFStringRef attribute, double timeout, AXError *status);
typedef NSString *(^PageAXGuard)(void);
typedef double (^PageAXClock)(void);
static id guardedPageAXRead(id element, CFStringRef attribute, PageAXRead read,
    PageAXGuard guard, PageAXClock clock, double deadline, NSString **error,
    bool optional) {
  *error = guard();
  if (*error) return nil;
  double remaining = deadline - clock();
  if (remaining <= 0) { *error = @"native-page-url-unverified"; return nil; }
  AXError status = kAXErrorFailure;
  id value = read(element, attribute, MIN(0.1, remaining / 1000), &status);
  // AX IPC can finish after the deadline or a concurrent authorization change.
  *error = guard();
  if (*error) return nil;
  if (clock() >= deadline) { *error = @"native-page-url-unverified"; return nil; }
  // Only AXChildren's explicit absence is a leaf. Messaging failures, or an
  // unreadable WebArea URL, never count as a zero-match/complete scan.
  bool absentChildren = optional && !value &&
    (status == kAXErrorNoValue || status == kAXErrorAttributeUnsupported);
  if (!absentChildren && (status != kAXErrorSuccess || !value)) {
    *error = @"native-page-ax-read-failed";
    return nil;
  }
  return value;
}
static NSString *pageAXString(id value) {
  return [value isKindOfClass:NSString.class] ? value :
    [value isKindOfClass:NSURL.class] ? [value absoluteString] : @"";
}
static bool scanPageAX(id element, int depth, int *budget, NSString *url,
    PageAXRead read, PageAXGuard guard, PageAXClock clock, double deadline,
    NSMutableArray *nodes, NSMutableArray *areas, NSString **error) {
  if (depth > 14 || --*budget < 0) {
    *error = @"native-page-ax-scan-incomplete";
    return false;
  }
  id children = guardedPageAXRead(element, kAXChildrenAttribute, read, guard, clock,
    deadline, error, true);
  if (*error) return false;
  if (!children) return true;
  if (![children isKindOfClass:NSArray.class] || [children count] > 200) {
    *error = @"native-page-ax-scan-incomplete";
    return false;
  }
  for (id child in children) {
    [nodes addObject:child];
    id role = guardedPageAXRead(child, kAXRoleAttribute, read, guard, clock,
      deadline, error, false);
    if (*error) return false;
    if (![role isKindOfClass:NSString.class] || ![role length]) {
      *error = @"native-page-ax-read-failed"; return false;
    }
    if ([role isEqual:@"AXWebArea"]) {
      id actualURL = guardedPageAXRead(child, CFSTR("AXURL"), read, guard, clock,
        deadline, error, false);
      if (*error) return false;
      NSString *urlString = pageAXString(actualURL);
      if (!urlString.length) { *error = @"native-page-ax-read-failed"; return false; }
      if ([urlString isEqual:url]) [areas addObject:child];
      if (areas.count > 1) { *error = @"native-page-url-unverified"; return false; }
    }
    if (!scanPageAX(child, depth + 1, budget, url, read, guard, clock, deadline,
        nodes, areas, error)) return false;
  }
  return true;
}
static NSString *waitForPageAX(id app, NSString *url, PageAXRead read,
    PageAXGuard guard, PageAXClock clock, void (^pause)(double), double deadline,
    id *verifiedWindow, NSArray **verifiedNodes, id *verifiedArea) {
  NSString *error = nil;
  id role = guardedPageAXRead(app, kAXRoleAttribute, read, guard, clock, deadline, &error, false);
  if (error) return error;
  if (![role isKindOfClass:NSString.class] || ![role isEqual:@"AXApplication"])
    return @"native-application-role-unverified";
  id window = guardedPageAXRead(app, kAXFocusedWindowAttribute, read, guard, clock,
    deadline, &error, false);
  if (error) return error;
  if (!window) return @"chrome-window-unavailable";
  PageAXGuard sameWindow = ^NSString *{
    NSString *failure = nil;
    id current = guardedPageAXRead(app, kAXFocusedWindowAttribute, read, guard, clock,
      deadline, &failure, false);
    if (failure) return failure;
    return current && CFEqual((__bridge CFTypeRef)current, (__bridge CFTypeRef)window) ?
      nil : @"native-page-window-changed";
  };
  while (true) {
    NSMutableArray *nodes = [NSMutableArray new], *areas = [NSMutableArray new];
    int budget = 20000;
    if (!scanPageAX(window, 0, &budget, url, read, sameWindow, clock, deadline,
        nodes, areas, &error)) return error;
    error = sameWindow();
    if (error) return error;
    if (areas.count == 1) {
      *verifiedWindow = window; *verifiedNodes = nodes; *verifiedArea = areas[0];
      return nil;
    }
    // Only a complete scan with zero matches may retry. No input is posted here.
    double remaining = deadline - clock();
    if (remaining <= 0) return @"native-page-url-unverified";
    pause(MIN(10, remaining));
    error = sameWindow();
    if (error) return error;
  }
}
static NSString *waitForTextReadiness(NSDictionary *request, AXUIElementRef target,
    AXUIElementRef app, pid_t expectedPid, CGRect expectedFrame, double deadline,
    bool selecting, NSString **originalValue) {
  do {
    NSString *error = textInputGuard(request, expectedPid);
    if (error) return error;
    if (monotonicMs() >= deadline) break;
    id focused = attr(app, kAXFocusedUIElementAttribute), value = attr(target, kAXValueAttribute);
    NSValue *frame = bounds(target);
    if (!frame || !unchangedTextFrame(expectedFrame, NSRectToCGRect(frame.rectValue)) ||
        ![str(target, kAXRoleAttribute) isEqual:@"AXTextField"])
      return @"native-text-target-changed";
    if (![value isKindOfClass:NSString.class]) return @"native-text-value-unverified";
    if (selecting && ![value isEqual:*originalValue]) return @"native-text-value-changed";
    pid_t focusedPid = 0;
    bool hasFocus = focused && CFGetTypeID((__bridge CFTypeRef)focused) == AXUIElementGetTypeID() &&
      AXUIElementGetPid((__bridge AXUIElementRef)focused, &focusedPid) == kAXErrorSuccess &&
      focusedPid == expectedPid && CFEqual((__bridge CFTypeRef)focused, target);
    bool ready = hasFocus;
    if (hasFocus && selecting) {
      id selected = attr(target, kAXSelectedTextRangeAttribute);
      CFRange range = CFRangeMake(kCFNotFound, 0);
      ready = selected && CFGetTypeID((__bridge CFTypeRef)selected) == AXValueGetTypeID() &&
        AXValueGetType((__bridge AXValueRef)selected) == kAXValueCFRangeType &&
        AXValueGetValue((__bridge AXValueRef)selected, kAXValueCFRangeType, &range) &&
        completeTextSelection(value, range);
    }
    // AX IPC may consume the remaining budget; never accept a stale read.
    error = textInputGuard(request, expectedPid);
    if (error) return error;
    if (monotonicMs() >= deadline) break;
    if (ready) {
      if (!selecting) *originalValue = [value copy];
      return nil;
    }
    usleep(10000);
  } while (monotonicMs() < deadline);
  return selecting ? @"native-text-selection-unverified" : @"native-text-focus-unverified";
}
static void configurePlainTextEvent(CGEventRef event, NSString *text, bool down) {
  if (!event) return;
  // Per-event flags must not inherit Command from the preceding select-all.
  CGEventSetFlags(event, 0);
  if (down) {
    UniChar chars[80];
    [text getCharacters:chars range:NSMakeRange(0, text.length)];
    CGEventKeyboardSetUnicodeString(event, text.length, chars);
  }
}
static NSString *inputText(NSString *text, bool numeric, NSDictionary *request,
    AXUIElementRef target, pid_t expectedPid, CGRect expectedFrame) {
  if (![text isKindOfClass:NSString.class] ||
      text.length > (numeric ? 8 : 80) ||
      [text rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet]
              .location != NSNotFound ||
      (numeric &&
       [text rangeOfCharacterFromSet:NSCharacterSet.decimalDigitCharacterSet
                                         .invertedSet]
               .location != NSNotFound))
    return @"input-text-not-allowed";
  if (!target) return @"native-text-target-unavailable";
  AXUIElementRef app = AXUIElementCreateApplication(expectedPid);
  if (!app) return @"native-text-application-unavailable";
  // Local read-message timeouts do not write AX attributes or selection state.
  if (AXUIElementSetMessagingTimeout(app, 0.1) != kAXErrorSuccess ||
      AXUIElementSetMessagingTimeout(target, 0.1) != kAXErrorSuccess) {
    CFRelease(app);
    return @"native-text-read-timeout-unavailable";
  }
  double deadline = monotonicMs() + 700;
  NSString *originalValue = nil;
  NSString *error = waitForTextReadiness(request, target, app, expectedPid, expectedFrame,
    deadline, false, &originalValue);
  if (!error) error = textInputGuard(request, expectedPid);
  if (!error) error = key(0, kCGEventFlagMaskCommand);
  if (!error) error = waitForTextReadiness(request, target, app, expectedPid, expectedFrame,
    deadline, true, &originalValue);
  CFRelease(app);
  if (!error) error = textInputGuard(request, expectedPid);
  if (error)
    return error;
  if (text.length == 0) return key(51, 0); // Backspace clears only the confirmed full selection.
  CGEventRef event = CGEventCreateKeyboardEvent(NULL, 0, true);
  configurePlainTextEvent(event, text, true);
  error = post(event);
  CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
  configurePlainTextEvent(up, text, false);
  CGEventSetIntegerValueField(up, kCGEventSourceUserData, marker);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(up);
  return error;
}
static NSString *validateAndExecute(NSDictionary *request) {
#ifdef CBG_INPUT_TEST_MONITOR
  return @"startup-test-input-disabled";
#endif
  NSString *activityError = activityFailure(request[@"plan"][@"activity"]);
  if (activityError) return activityError;
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
  if ([target[@"kind"] isEqual:@"query-field"] && !queryFieldValueAllowed(target[@"field"], target[@"value"]))
    return @"native-query-field-value-not-allowed";
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
  id app = CFBridgingRelease(AXUIElementCreateApplication(pid));
  double readinessDeadline = monotonicMs() + MIN(700,
    proofDeadline - NSDate.date.timeIntervalSince1970 * 1000);
  PageAXRead read = ^id(id element, CFStringRef attribute, double timeout, AXError *status) {
    if (!element || CFGetTypeID((__bridge CFTypeRef)element) != AXUIElementGetTypeID()) {
      *status = kAXErrorInvalidUIElement; return nil;
    }
    AXUIElementRef el = (__bridge AXUIElementRef)element;
    *status = AXUIElementSetMessagingTimeout(el, (float)timeout);
    if (*status != kAXErrorSuccess) return nil;
    CFTypeRef value = NULL;
    *status = AXUIElementCopyAttributeValue(el, attribute, &value);
    return CFBridgingRelease(value);
  };
  id window = nil, area = nil;
  NSArray *nodes = nil;
  // Normal read-only AT handshake, then bounded zero-match readiness sampling.
  // The original proof deadline, activity and focused window never change.
  error = waitForPageAX(app, proof[@"url"], read,
    ^{ return pageInputGuard(request, pid); }, ^{ return monotonicMs(); },
    ^(double ms) { usleep((useconds_t)(ms * 1000)); }, readinessDeadline,
    &window, &nodes, &area);
  if (error) return error;
  NSValue *windowValue = bounds((__bridge AXUIElementRef)window);
  if (!windowValue)
    return @"native-window-frame-unavailable";
  CGRect windowFrame = NSRectToCGRect(windowValue.rectValue);
  NSValue *web = bounds((__bridge AXUIElementRef)area);
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
  if (!displayAvailable(displays[0])) return @"native-screen-unavailable";
  pthread_mutex_lock(&activityLock); activityDisplay = displays[0]; pthread_mutex_unlock(&activityLock);
  CGRect screen = CGDisplayBounds(displays[0]);
  CGDisplayModeRef displayMode = CGDisplayCopyDisplayMode(displays[0]);
  if (!displayMode) return @"native-screen-mode-unavailable";
  NativeDisplayMode dimensions = {
    CGDisplayModeGetWidth(displayMode), CGDisplayModeGetHeight(displayMode),
    CGDisplayModeGetPixelWidth(displayMode), CGDisplayModeGetPixelHeight(displayMode),
    CGDisplayRotation(displays[0])};
  CGDisplayModeRelease(displayMode);
  // Rotated displays require separate physical validation; do not guess axis mapping.
  if (!isfinite(dimensions.rotation) || fabs(dimensions.rotation) > 0.001)
    return @"native-screen-rotation-unsupported";
  if (!CGRectContainsRect(screen, targetRect) ||
      !displayScaleMatches(screen.size, dimensions, sx, [v[@"dpr"] doubleValue]))
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
  id verifiedHit = CFBridgingRelease(hit);
  if (error)
    return error;
  if ([kind isEqual:@"return-to-list"] || [kind isEqual:@"refresh-list"]) {
    error = key([kind isEqual:@"refresh-list"]
                    ? 15
                    : ([proof[@"ownedChildTab"] boolValue] ? 13 : 33),
                kCGEventFlagMaskCommand);
    return error;
  }
  error = post(CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, point,
                                       kCGMouseButtonLeft));
  if ([kind isEqual:@"scroll"]) {
    if (!error)
      error = post(CGEventCreateScrollWheelEvent(
          NULL, kCGScrollEventUnitPixel, 1,
          (int32_t)-round([target[@"deltaY"] doubleValue] * sy)));
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
    error = inputText([target[@"page"] stringValue], true, request,
      (__bridge AXUIElementRef)verifiedHit, pid, NSRectToCGRect(nativeHitFrame.rectValue));
    if (!error)
      error = key(36, 0);
  }
  if (!error && [kind isEqual:@"query-field"])
    error = inputText(target[@"value"], false, request,
      (__bridge AXUIElementRef)verifiedHit, pid, NSRectToCGRect(nativeHitFrame.rectValue));
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
      error = inputText(target[@"value"], false, request,
        (__bridge AXUIElementRef)verifiedHit, pid, NSRectToCGRect(nativeHitFrame.rectValue));
  }
  return error ?: check();
}
static void observeInputPreemption(bool disabled, bool foreignInput, const InputEventMetadata *event) {
  bool owned = atomic_load_explicit(&ownsInput, memory_order_acquire);
  if (event && (disabled || (foreignInput && owned))) {
    unsigned empty = 0;
    // Immutable first-event snapshot: no lock, allocation, Objective-C or I/O here.
    if (atomic_compare_exchange_strong_explicit(&preemptionRecordState, &empty, 1,
        memory_order_acq_rel, memory_order_relaxed)) {
      atomic_store(&firstPreemptionType, event->type);
      atomic_store(&firstEventAtNs, event->timestampNs);
      atomic_store(&firstCallbackAtNs, inputAbsoluteNs());
      atomic_store(&firstGrantAtNs, atomic_load(&inputGrantAtNs));
      atomic_store(&firstGrantEpoch, atomic_load(&inputGrantEpoch));
      atomic_store(&firstSourcePid, event->sourcePid); atomic_store(&firstUserData, event->userData);
      atomic_store(&firstSourceStateID, event->sourceStateID);
      atomic_store(&firstHasMouse, event->hasMouse); atomic_store(&firstMouseLocationAvailable, event->locationAvailable);
      atomic_store(&firstMouseXBits, coordinateBits(event->location.x));
      atomic_store(&firstMouseYBits, coordinateBits(event->location.y));
      atomic_store(&firstMouseDeltaX, event->deltaX); atomic_store(&firstMouseDeltaY, event->deltaY);
      atomic_store(&firstGrantPointerAvailable, atomic_load(&grantPointerAvailable));
      atomic_store(&firstGrantPointerXBits, atomic_load(&grantPointerXBits));
      atomic_store(&firstGrantPointerYBits, atomic_load(&grantPointerYBits));
      atomic_store(&firstOwnedInput, owned); atomic_store(&firstTapDisabled, disabled);
      atomic_store_explicit(&preemptionRecordState, 2, memory_order_release);
    }
  }
  if (disabled) {
    tapReady = false;
    preempted = true;
    return;
  }
  if (!foreignInput) return;
  // Idle input must not poison the next workflow; active page waits still own
  // input. Never wait for activityLock on the event tap's deadline-sensitive thread.
  if (owned) preempted = true;
}
static CGEventRef tapCallback(CGEventTapProxy proxy, CGEventType type,
                              CGEventRef event, void *refcon) {
  bool disabled = type == kCGEventTapDisabledByTimeout ||
                  type == kCGEventTapDisabledByUserInput;
  CGPoint location = event ? CGEventGetLocation(event) : CGPointZero;
  InputEventMetadata metadata = {(uint32_t)type, event ? CGEventGetTimestamp(event) : 0,
    event ? CGEventGetIntegerValueField(event, kCGEventSourceUnixProcessID) : 0,
    event ? CGEventGetIntegerValueField(event, kCGEventSourceUserData) : 0,
    event ? CGEventGetIntegerValueField(event, kCGEventSourceStateID) : 0,
    event && type == kCGEventMouseMoved ? CGEventGetIntegerValueField(event, kCGMouseEventDeltaX) : 0,
    event && type == kCGEventMouseMoved ? CGEventGetIntegerValueField(event, kCGMouseEventDeltaY) : 0,
    location, event && type == kCGEventMouseMoved, event && isfinite(location.x + location.y)};
  observeInputPreemption(disabled, !disabled && metadata.userData != marker, &metadata);
  return event;
}
static void writeResult(NSDictionary *value) {
  static pthread_mutex_t outputLock = PTHREAD_MUTEX_INITIALIZER;
  NSData *data = [NSJSONSerialization dataWithJSONObject:value
                                                 options:NSJSONWritingSortedKeys
                                                   error:NULL];
  pthread_mutex_lock(&outputLock);
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
  pthread_mutex_unlock(&outputLock);
}
int main(int argc, const char **argv) {
  @autoreleasepool {
    mach_timebase_info(&inputTimebase);
    if (argc > 1 && strcmp(argv[1], "--text-event-self-test") == 0) {
      CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
      CGEventRef down = source ? CGEventCreateKeyboardEvent(source, 0, true) : NULL,
                 up = source ? CGEventCreateKeyboardEvent(source, 0, false) : NULL;
      if (!source || !down || !up) {
        writeResult(@{@"kind": @"input-text-event-self-test", @"ok": @NO, @"available": @NO,
          @"error": @"graphics-event-source-unavailable", @"osInputPosted": @NO});
        if (down) CFRelease(down); if (up) CFRelease(up); if (source) CFRelease(source);
        return 2;
      }
      CGEventSetFlags(down, kCGEventFlagMaskCommand | kCGEventFlagMaskShift);
      CGEventSetFlags(up, kCGEventFlagMaskCommand | kCGEventFlagMaskControl);
      configurePlainTextEvent(down, @"120", true);
      configurePlainTextEvent(up, @"120", false);
      UniChar actual[80]; UniCharCount count = 0;
      CGEventKeyboardGetUnicodeString(down, 80, &count, actual);
      bool valid = CGEventGetFlags(down) == 0 && CGEventGetFlags(up) == 0 && count == 3 &&
        actual[0] == '1' && actual[1] == '2' && actual[2] == '0' &&
        CGEventGetType(down) == kCGEventKeyDown && CGEventGetType(up) == kCGEventKeyUp;
      writeResult(@{@"kind": @"input-text-event-self-test", @"ok": @(valid), @"available": @YES,
        @"downFlags": @(CGEventGetFlags(down)), @"upFlags": @(CGEventGetFlags(up)),
        @"unicode": [NSString stringWithCharacters:actual length:count], @"osInputPosted": @NO});
      CFRelease(down); CFRelease(up); CFRelease(source);
      return valid ? 0 : 1;
    }
    if (argc > 1 && strcmp(argv[1], "--preemption-self-test") == 0) {
      // Pure authorization transitions through the exact callback guard; no event
      // tap or OS input is created.
      if (!atomic_is_lock_free(&ownsInput)) return 1;
      stopped = preempted = false; tapReady = true;
      observeInputPreemption(false, true, NULL);
      if (preempted || stopped || !tapReady) return 1;
      acceptedHostInstance = @"guard-host"; acceptedGeneration = 1;
      acceptedStopEpoch = 0; acceptedSessionEpoch = @"guard-session";
      NSDictionary *oldLease = @{@"activityId": @"old-guard", @"authorizationEpoch": @1,
        @"stopEpoch": @0, @"browserSessionEpoch": acceptedSessionEpoch};
      NSDictionary *newLease = @{@"activityId": @"new-guard", @"authorizationEpoch": @2,
        @"stopEpoch": @0, @"browserSessionEpoch": acceptedSessionEpoch};
      NSDictionary *oldEnd = @{@"command": @"activity-end", @"activity": oldLease,
        @"hostInstanceEpoch": acceptedHostInstance, @"hostGeneration": @1};
      NSDictionary *newEnd = @{@"command": @"activity-end", @"activity": newLease,
        @"hostInstanceEpoch": acceptedHostInstance, @"hostGeneration": @1};
      pthread_mutex_lock(&activityLock);
      activeActivity = oldLease; publishInputOwnership();
      pthread_mutex_unlock(&activityLock);
      if (activityCommand(oldEnd) || ownsInput || activeActivity) return 1;
      pthread_mutex_lock(&activityLock);
      activeActivity = newLease; publishInputOwnership();
      pthread_mutex_unlock(&activityLock);
      DesktopGuard ready = {stopped, preempted, tapReady, true, true, false, true, true};
      if (!ownsInput || guardFailure(ready)) return 1; // Idle input allows a new owner.
      observeInputPreemption(false, false, NULL);
      if (preempted) return 1; // Marked native events do not preempt their own workflow.
      if (![activityCommand(oldEnd) isEqual:@"stale-native-activity-end"] ||
        !ownsInput || activeActivity != newLease) return 1;
      invalidateActivityFor(oldLease, @"stale-guard", false);
      if (!ownsInput || activeActivity != newLease || stopped) return 1;
      postedAny = true;
      atomic_store(&grantPointerXBits, coordinateBits(100.5));
      atomic_store(&grantPointerYBits, coordinateBits(-12.25));
      atomic_store(&grantPointerAvailable, true);
      InputEventMetadata event = {kCGEventMouseMoved, atomic_load(&inputGrantAtNs) - 1, 123, 456, 0, 0, 0,
        CGPointMake(100.5, -12.25), true, true};
      // This would deadlock if the callback guard waited for activityLock.
      pthread_mutex_lock(&activityLock);
      observeInputPreemption(false, true, &event);
      pthread_mutex_unlock(&activityLock);
      ready.preempted = preempted;
      NSDictionary *observed = inputPreemptionDiagnostic();
      if (!preempted || !guardFailure(ready) || ![observed[@"ownsInput"] boolValue] ||
        [observed[@"tapDisabled"] boolValue] || [observed[@"sourcePid"] intValue] != 123 ||
        [observed[@"userData"] intValue] != 456 || [observed[@"authorizationEpoch"] intValue] != 2 ||
        [observed[@"diagnosticSchema"] intValue] != 2 || [observed[@"sourceStateID"] intValue] != 0 ||
        [observed[@"mouse"][@"deltaX"] intValue] != 0 || [observed[@"mouse"][@"deltaY"] intValue] != 0 ||
        ![observed[@"grantPointerAvailable"] boolValue] ||
        ![observed[@"mouse"][@"location"] isEqual:observed[@"grantPointer"]] ||
        strtoull([observed[@"eventTimestampNs"] UTF8String], NULL, 10) >=
        strtoull([observed[@"grantTimestampNs"] UTF8String], NULL, 10)) return 1;
      event.deltaX = 7; event.deltaY = -3; event.location = CGPointMake(107.5, -15.25);
      observeInputPreemption(false, true, &event);
      if (![inputPreemptionDiagnostic() isEqual:observed]) return 1;
      preempted = false; postedAny = false;
      observeInputPreemption(false, true, NULL);
      ready.preempted = preempted;
      if (!preempted || !guardFailure(ready)) return 1; // Waiting still owns input.
      preempted = false;
      if (activityCommand(newEnd) || ownsInput || activeActivity) return 1;
      observeInputPreemption(false, true, NULL);
      if (preempted) return 1; // Input after activity end is idle input.
      pthread_mutex_lock(&activityLock);
      activeActivity = newLease; releaseInputOwnership();
      pthread_mutex_unlock(&activityLock);
      observeInputPreemption(false, true, NULL);
      if (preempted) return 1;
      pthread_mutex_lock(&activityLock);
      publishInputOwnership();
      pthread_mutex_unlock(&activityLock);
      invalidateActivityFor(newLease, @"current-guard", false);
      if (ownsInput || activeActivity || !stopped) return 1;
      atomic_store(&preemptionRecordState, 0); // Only this no-input state test resets the immutable record.
      tapCallback(NULL, kCGEventTapDisabledByTimeout, NULL, NULL);
      if (!preempted || tapReady || ![inputPreemptionDiagnostic()[@"tapDisabled"] boolValue] ||
        inputPreemptionDiagnostic()[@"mouse"]) return 1;
      preempted = false; tapReady = true;
      tapCallback(NULL, kCGEventTapDisabledByUserInput, NULL, NULL);
      if (!preempted || tapReady) return 1; // Both disabled events are unconditional.
      stopped = true; preempted = false;
      observeInputPreemption(false, true, NULL);
      if (!stopped || tapReady) return 1; // Idle gating never clears an explicit stop/disabled tap.
      writeResult(@{@"kind": @"input-preemption-self-test", @"ok": @YES,
        @"checks": @14, @"osInputPosted": @NO});
      return 0;
    }
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
      DesktopGuard ready = {false, false, true, true, true, false, true, true};
      if (guardFailure(ready))
        return 1;
      DesktopGuard variants[8] = {ready, ready, ready, ready,
                                  ready, ready, ready, ready};
      variants[0].stopped = true;
      variants[1].preempted = true;
      variants[2].tapReady = false;
      variants[3].accessibility = false;
      variants[4].inputMonitoring = false;
      variants[5].locked = true;
      variants[6].chromeForeground = false;
      variants[7].displayAvailable = false;
      for (int index = 0; index < 8; index++)
        if (!guardFailure(variants[index]))
          return 1;
      if (monitorState(true, false) || monitorState(false, true) ||
          !monitorState(true, true))
        return 1;
      if (!timely(9, 10, 11) || timely(10, 10, 11) || timely(10, 11, 10)) return 1;
      if (!queryFieldValueAllowed(@"price_min", @"100.50") || !queryFieldValueAllowed(@"price_max", @"99999999.99") ||
        !queryFieldValueAllowed(@"price_min", @"") || !queryFieldValueAllowed(@"level_max", @"175") ||
        queryFieldValueAllowed(@"level_min", @"175.5") || queryFieldValueAllowed(@"price_min", @"1;open") ||
        queryFieldValueAllowed(@"price_max", @"100000000") || queryFieldValueAllowed(@"password", @"1")) return 1;
      if (!completeTextSelection(@"100", CFRangeMake(0, 3)) ||
        completeTextSelection(@"100", CFRangeMake(3, 0)) ||
        completeTextSelection(@"100", CFRangeMake(0, 2)) ||
        completeTextSelection(@"100", CFRangeMake(1, 3)) ||
        completeTextSelection(@"100", CFRangeMake(kCFNotFound, 0)) ||
        !completeTextSelection(@"", CFRangeMake(0, 0)) ||
        completeTextSelection(nil, CFRangeMake(0, 0)) ||
        !completeTextSelection(@"😀3", CFRangeMake(0, 3)) ||
        !unchangedTextFrame(CGRectMake(10, 20, 100, 30), CGRectMake(10, 20, 100, 30)) ||
        unchangedTextFrame(CGRectMake(10, 20, 100, 30), CGRectMake(12, 20, 100, 30))) return 1;
      CGSize desktop = CGSizeMake(1440, 900);
      NativeDisplayMode one = {1440, 900, 1440, 900, 0}, two = {1440, 900, 2880, 1800, 0};
      if (!displayScaleMatches(desktop, one, 1, 1) ||
        !displayScaleMatches(desktop, two, 1, 2) ||
        !displayScaleMatches(desktop, two, 1.25, 2.5) ||
        displayScaleMatches(desktop, two, 1, 1) ||
        displayScaleMatches(desktop, (NativeDisplayMode){0, 0, 0, 0, 0}, 1, 2) ||
        displayScaleMatches(desktop, (NativeDisplayMode){1440, 900, 0, 1800, 0}, 1, 2) ||
        displayScaleMatches(desktop, (NativeDisplayMode){1440, 900, NAN, 1800, 0}, 1, 2) ||
        displayScaleMatches(desktop, (NativeDisplayMode){1440, 900, 2880, 900, 0}, 1, 2) ||
        displayScaleMatches(desktop, (NativeDisplayMode){1280, 900, 2560, 1800, 0}, 1, 2) ||
        displayScaleMatches(desktop, (NativeDisplayMode){1440, 900, 2880, 1800, 90}, 1, 2) ||
        displayScaleMatches(desktop, (NativeDisplayMode){1440, 900, 2880, 1800, 270}, 1, 2) ||
        displayScaleMatches(desktop, two, 1, -2) ||
        displayScaleMatches(desktop, two, 0, 2) ||
        displayScaleMatches(desktop, two, 1, NAN)) return 1;
      puts("native activity, query-field, coordinate and desktop-guard self-tests passed (55 "
           "assertions, no input posted)");
      return 0;
    }
    signal(SIGUSR1, emergencyStop);
    dispatch_semaphore_t monitorStarted = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
#ifdef CBG_INPUT_TEST_MONITOR
      usleep(CBG_INPUT_TEST_MONITOR_DELAY_MS * 1000);
      tapReady = CBG_INPUT_TEST_MONITOR_READY != 0;
      dispatch_semaphore_signal(monitorStarted);
#else
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
        dispatch_semaphore_signal(monitorStarted);
        return;
      }
      CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(NULL, tap, 0);
      if (!source) {
        stopped = true;
        CFRelease(tap);
        dispatch_semaphore_signal(monitorStarted);
        return;
      }
      CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
      CGEventTapEnable(tap, true);
      pthread_mutex_lock(&monitorLock);
      activeMonitorTap = tap;
      pthread_mutex_unlock(&monitorLock);
      tapReady = CGEventTapIsEnabled(tap);
      if (tapReady) {
        // Signal from the running loop, after its event tap source is installed.
        CFRunLoopPerformBlock(CFRunLoopGetCurrent(), kCFRunLoopCommonModes, ^{
          dispatch_semaphore_signal(monitorStarted);
        });
        CFRunLoopRun();
      } else dispatch_semaphore_signal(monitorStarted);
      tapReady = false;
      pthread_mutex_lock(&monitorLock);
      activeMonitorTap = NULL;
      pthread_mutex_unlock(&monitorLock);
      CFRelease(source);
      CFRelease(tap);
#endif
    });
    long startup = dispatch_semaphore_wait(monitorStarted,
      dispatch_time(DISPATCH_TIME_NOW, CBG_INPUT_STARTUP_TIMEOUT_MS * NSEC_PER_MSEC));
    if (startup != 0 || !inputMonitorActive()) {
      stopped = true;
      writeResult(@{@"kind": @"input-unavailable", @"version": @1,
        @"error": startup != 0 ? @"input-monitor-startup-timeout" : @"input-monitor-startup-failed"});
      return 1;
    }
    writeResult(@{@"kind" : @"input-ready", @"version" : @1});
    dispatch_source_t activityWatchdog = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    dispatch_source_set_timer(activityWatchdog, dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), 100 * NSEC_PER_MSEC, 10 * NSEC_PER_MSEC);
    dispatch_source_set_event_handler(activityWatchdog, ^{
      @autoreleasepool {
        pthread_mutex_lock(&activityLock);
        NSDictionary *lease = activeActivity;
        bool active = lease != nil;
        bool expired = active && !timely(monotonicMs(), activityDeadline, progressDeadline);
        CGDirectDisplayID display = activityDisplay;
        pthread_mutex_unlock(&activityLock);
        checkActivityWatchdog(active ? lease : nil, expired, display,
          ^{ return check(); }, ^bool(CGDirectDisplayID value) { return displayAvailable(value); },
          ^(NSDictionary *expected, NSString *reason) { invalidateActivityFor(expected, reason, true); });
      }
    });
    dispatch_resume(activityWatchdog);
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
          if ([command hasPrefix:@"activity-"]) {
            NSString *error = activityCommand(request);
            pthread_mutex_lock(&activityLock);
            bool active = activeActivity && ownsInput && !stopped && !preempted &&
              timely(monotonicMs(), activityDeadline, progressDeadline);
            pthread_mutex_unlock(&activityLock);
            writeResult(@{@"ok": @((bool)!error), @"actionId": actionId, @"activityId": request[@"activity"][@"activityId"] ?: @"", @"active": @(active), @"error": error ?: @""});
          } else if ([command isEqual:@"status"])
            writeResult(@{
              @"ok" : @YES,
              @"actionId" : actionId,
              @"activity": activityStatus(),
              @"inputPreemption": inputPreemptionDiagnostic(),
              @"permissions" : @{
                @"accessibility" : @((bool)AXIsProcessTrusted()),
                @"inputMonitoring" : @(CGPreflightListenEventAccess()),
                @"inputMonitorActive" : @(inputMonitorActive()),
                @"screenRecording" : @(CGPreflightScreenCaptureAccess()),
                @"locked" : @(locked()),
                @"displayAvailable": @(anyDisplay()),
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
            invalidateActivity(@"native-stop", false);
            writeResult(@{@"ok" : @YES, @"actionId" : actionId});
          } else if ([command isEqual:@"resume"]) {
            invalidateActivity(@"native-resume-invalidated-old-activity", false);
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
            if (!error && postedAny) { pthread_mutex_lock(&activityLock); lastPostedAction = actionId; pthread_mutex_unlock(&activityLock); }
            if (error) invalidateActivityFor(request[@"plan"][@"activity"], error, true);
            writeResult(error ? @{
              @"ok" : @NO,
              @"actionId" : actionId,
              @"error" : error,
              @"inputPreemption": inputPreemptionDiagnostic(),
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
          invalidateActivity(@"native-invalid-command", true);
          writeResult(@{@"ok" : @NO, @"error" : @"native-invalid-command"});
        }
      }
    }
    free(line);
    dispatch_source_cancel(activityWatchdog);
    invalidateActivity(@"native-input-disconnected", false);
    return 0;
  }
}
