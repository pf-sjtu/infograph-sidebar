import buildInfo from "./build-info.json";

export interface BuildInfo {
	date: string;
	build: number;
}

export function getBuildInfo(): BuildInfo {
	return {
		date: String((buildInfo as BuildInfo).date || "00000000"),
		build: Number((buildInfo as BuildInfo).build) || 1,
	};
}

/** User-facing version: vYYYYMMDD.bN */
export function getVersionLabel(): string {
	const {date, build} = getBuildInfo();
	return `v${date}.b${build}`;
}
