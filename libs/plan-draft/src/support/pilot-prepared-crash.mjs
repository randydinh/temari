import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const link = promises.link;
promises.link = async (source, destination) => {
  await link(source, destination);
  if (String(destination).endsWith('-prepared.json')) process.exit(73);
};
syncBuiltinESMExports();
