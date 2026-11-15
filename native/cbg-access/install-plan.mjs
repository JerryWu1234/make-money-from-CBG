export const HOST_FILES = [
  "host.json",
  "host.mjs",
  "command-authority.mjs",
  "launch-host",
  "cbg-input",
];
export function nativeHostManifest(directory, extensionId) {
  if (
    !/^[a-p]{32}$/.test(extensionId || "") ||
    typeof directory !== "string" ||
    !directory.startsWith("/")
  )
    throw new Error("invalid-native-host-install-plan");
  return {
    name: "com.cbg.access_bridge",
    description: "CBG authorized local observer/input bridge",
    path: directory + "/launch-host",
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}
