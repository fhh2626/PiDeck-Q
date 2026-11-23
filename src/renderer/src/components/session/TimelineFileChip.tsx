import { useContext } from "react";
import { LocalFileLink } from "./LocalFileLink";
import { MarkdownFileBasePathContext } from "./MarkdownFileBasePath";
import { unwrapFileChipPath, type ComposerChip } from "./composer/chips";
import { filePathToUri, resolveFileLinkPath } from "../../utils/fileLinks";

/** User-message file references share the same directory routing as Markdown links. */
export function TimelineFileChip({ chip, onOpenFile }: {
	chip: ComposerChip;
	onOpenFile: (path: string) => void;
}) {
	const basePath = useContext(MarkdownFileBasePathContext);
	const path = resolveFileLinkPath(unwrapFileChipPath(chip.raw), basePath);
	return (
		<LocalFileLink
			path={path}
			href={filePathToUri(path)}
			className="input-chip input-chip--file clickable no-underline"
			labelClassName="input-chip__label"
			data-type="file"
			data-raw={chip.raw}
			title={path}
			onClick={(event) => {
				event.preventDefault();
				onOpenFile(path);
			}}
		>
			{chip.label}
		</LocalFileLink>
	);
}
