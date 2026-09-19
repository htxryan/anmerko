export function buildReleaseDemo(sourceRoot: string, output: string): Promise<{
  entry: string;
  files: Record<string, { file: string; sha256: string }>;
}>;
