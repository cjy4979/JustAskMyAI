export const ARTIFACT_KINDS = [
  "text",
  "report",
  "file",
  "patch",
  "commit",
  "manifest",
  "execution-log",
] as const;

export type ArtifactKind = typeof ARTIFACT_KINDS[number];

export interface RemoteArtifact {
  id: string;
  taskId: string;
  kind: ArtifactKind;
  mediaType: string;
  name: string;
  digest?: string;
  content?: unknown;
  reference?: string;
}
