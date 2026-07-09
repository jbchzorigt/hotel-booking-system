import { redirect } from "next/navigation";

/** The portal entry point lands on the live-alerts dispatch view. */
export default function PoliceIndexPage() {
  redirect("/police/alerts");
}
