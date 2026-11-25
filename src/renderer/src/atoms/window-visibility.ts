import { atom } from "jotai";

/** Qt window exposure is independent of the embedded document's visibility. */
export const nativeWindowVisibleAtom = atom<boolean | null>(null);
