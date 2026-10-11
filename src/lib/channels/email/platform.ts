import { z } from "zod";

import { GMAIL_PLATFORMS } from "@/lib/config";

export const gmailPlatformSchema = z.enum(GMAIL_PLATFORMS);
