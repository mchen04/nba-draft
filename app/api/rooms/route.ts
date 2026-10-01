import { NextRequest } from "next/server";
import { createRoom, createSchema } from "@/lib/engine";
import { body, json, problem } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: NextRequest) {
  try {
    const input = createSchema.parse(await body(request));
    const result = await createRoom(
      input.name,
      input.commissioner,
      input.settings,
    );
    return json(
      { id: result.room.id, recoveryCode: result.recoveryCode },
      201,
      { id: result.room.id, token: result.token },
    );
  } catch (error) {
    return problem(error);
  }
}
