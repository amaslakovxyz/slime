import { redirect } from 'next/navigation';

// The endpoint opens on its Lifecycle tab; Overview was folded into Lifecycle and Usage.
export default async function EndpointPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/endpoints/${id}/lifecycle`);
}
