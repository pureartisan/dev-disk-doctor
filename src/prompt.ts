import { addSavedRoot, checkRoot, hasRootsChoice, saveAutoDiscover } from './core/config.js';

export interface Io {
  /** Show text to the user (stderr in the CLI, so JSON and report output on stdout stay clean). */
  say(text: string): void;
  /** Ask a question and return the typed answer. Rejects if the input is closed. */
  ask(question: string): Promise<string>;
}

export interface RootsAnswer {
  /** Folders to search for this run only. Empty means "let it figure it out". */
  roots: string[];
}

const MENU = `No workspace folders are saved yet. Where should dev-disk-doctor look for your projects?
  1) Figure it out for me, and don't ask again   (recommended)
  2) I'll type the folders, and remember them
  3) I'll type the folders, just for this run
  4) Skip: figure it out this time, ask again next time`;

/** The typed answer, or undefined when the input was closed (Ctrl-D, closed pipe). */
async function read(io: Io, question: string): Promise<string | undefined> {
  try {
    return (await io.ask(question)).trim();
  } catch {
    return undefined;
  }
}

/** Ask for folders, re-asking on a bad one. An empty answer or closed input gives up and returns undefined. */
async function askFolders(io: Io, home: string): Promise<string[] | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await read(io, 'Folders to search (separate several with commas, ~ works, empty to cancel): ');
    if (!answer) return undefined;
    const parts = answer.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    try {
      return await Promise.all(parts.map((p) => checkRoot(home, p)));
    } catch (e) {
      io.say(e instanceof Error ? e.message : String(e));
    }
  }
  io.say('Giving up on that; figuring it out for this run.');
  return undefined;
}

/** Run a save, and keep going with the scan if the config cannot be written. */
async function trySave(io: Io, save: () => Promise<unknown>, done: string): Promise<void> {
  try {
    await save();
    io.say(done);
  } catch (e) {
    io.say(`Could not save that: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The first-run question. Asked only when nothing says where to look: no saved folders, no earlier
 * "figure it out" choice, and no DEV_DISK_DOCTOR_ROOTS. The caller decides whether the terminal is
 * interactive and whether `--root` was passed.
 */
export async function askRoots(io: Io, home: string, env: NodeJS.ProcessEnv = process.env): Promise<RootsAnswer> {
  if (await hasRootsChoice(home, env)) return { roots: [] };

  io.say(MENU);
  const answer = await read(io, 'Choose 1-4 [1]: ');
  if (answer === undefined) return { roots: [] }; // input closed: behave like "skip"
  const choice = answer || '1';

  switch (choice) {
    case '1':
      await trySave(io, () => saveAutoDiscover(home), 'Remembered. Change it any time with "dev-disk-doctor roots add <dir>" or "roots reset".\n');
      return { roots: [] };
    case '2':
    case '3': {
      const folders = await askFolders(io, home);
      if (!folders) return { roots: [] };
      if (choice === '2') {
        await trySave(
          io,
          async () => {
            for (const f of folders) await addSavedRoot(home, f);
          },
          'Saved. Change it any time with "dev-disk-doctor roots add|remove <dir>".\n',
        );
      }
      return { roots: folders };
    }
    case '4':
      return { roots: [] };
    default:
      io.say(`"${choice}" is not one of the options; figuring it out for this run.\n`);
      return { roots: [] };
  }
}
