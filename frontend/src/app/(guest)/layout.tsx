import GuestLayout from "@/components/layouts/GuestLayout";

export default function GuestGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <GuestLayout>{children}</GuestLayout>;
}
