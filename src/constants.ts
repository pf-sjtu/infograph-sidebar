export const VIEW_TYPE_INFOGRAPH_SIDEBAR = "infograph-sidebar-view";

/**
 * Deploy target hint shown in settings.
 * Actual deploy path is set via INFOGRAPH_OBSIDIAN_PLUGIN_DIR (see scripts/deploy.mjs).
 */
export const DEFAULT_DEPLOY_HINT =
	"<vault>/.obsidian/plugins/infograph-sidebar";

export const MIN_NOTE_CHARS = 40;
/** Default max number of distinct notes with cached infographic packs */
export const DEFAULT_MAX_CACHE_ENTRIES = 100;
