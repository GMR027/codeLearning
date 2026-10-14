import { join } from "path";
import { buildCurriculum } from "../src/curriculum";
import { collectExtras, walk } from "../src/analyzer";
import { buildProfile } from "../src/profile";

export const FIXTURES = join(__dirname, "..", "test", "fixtures");
export const TIENDA = join(FIXTURES, "tienda-api");

/** Analiza un proyecto sin IA: perfil + temario completo. */
export async function analyzeOffline(root: string) {
  const files = await walk(root);
  const extras = await collectExtras(root);
  return { files, extras, profile: buildProfile(root, files, { empty: extras.empty }), curriculum: buildCurriculum(files, [], extras) };
}
