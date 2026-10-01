import DraftRoom from "./room";
export default async function RoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DraftRoom id={id} />;
}
