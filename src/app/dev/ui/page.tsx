import { notFound } from "next/navigation";

export default async function DevUIPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  const { Gallery } = await import("./gallery");
  return <Gallery />;
}
