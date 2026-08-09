/* Source default. Deployment builds replace this file with an explicit mode. */
window.COZY_RUNTIME_CONFIG = Object.assign({
  mode: "auto",
  appName: "阿栗",
  apiBase: "",
  dataSource: "auto",
  allowWrites: true,
  instanceId: "local-dev"
}, window.COZY_RUNTIME_CONFIG || {});
