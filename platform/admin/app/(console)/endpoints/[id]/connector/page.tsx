import { redirect } from 'next/navigation';

// The connection now lives on the Settings tab; old links land there.
export default async function ConnectorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/endpoints/${id}/settings`);
}
