//#region lib/types/index.js
/**
 * 「AI 打工人」node half.
 *
 * Pure UI plugin: the browser half ships through `exports["./client"]` and is
 * discovered by @deepseek-ai/dsh-client-modules from the `dsh.client`
 * declaration in package.json. The host contributes nothing, so this apply is
 * intentionally empty — it exists only so the plugin owns a Loader row that the
 * client-module scanner can see.
 */

/** Host plugin body — no host-side behavior for this source plugin. */
export function apply() {}
//#endregion
