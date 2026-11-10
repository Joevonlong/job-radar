import fsp from "node:fs/promises";

import { withFileLock } from "@/lib/config/write";
import { lockLostError, withConfigWriteLock } from "@/lib/config/write-lock";
import { careerContactPath, careerDir, careerHistoryDir, careerProfilePath } from "./paths";

export async function clearCareerHistory(): Promise<void> {
  await withFileLock(careerProfilePath(), () =>
    withConfigWriteLock(async (lock) => {
      if (!(await lock.fence())) throw lockLostError(careerHistoryDir());
      await fsp.rm(careerHistoryDir(), { recursive: true, force: true });
    }, careerHistoryDir()),
  );
}

/** The cancellation hook lets request owners stop outstanding work before files disappear. */
export async function deleteCareerData(beforeDelete: () => Promise<void> = async () => {}): Promise<void> {
  await withFileLock(careerProfilePath(), () =>
    withFileLock(careerContactPath(), () =>
      withConfigWriteLock(async (lock) => {
        await beforeDelete();
        if (!(await lock.fence())) throw lockLostError(careerDir());
        await fsp.rm(careerDir(), { recursive: true, force: true });
      }, careerDir()),
    ),
  );
}
