import { z } from "zod";
import { UpdateRunDriverSchema } from "./update-run-driver-schema.js";

export const standaloneDoctorCaptureId =
  /^doctor-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const doctorCaptureCompletionSchema = z.strictObject({
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  completedAtMs: z.number().int().nonnegative(),
  driver: UpdateRunDriverSchema,
});
