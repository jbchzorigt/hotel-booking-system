"use client";

import { useCallback, useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { isAxiosError } from "axios";
import { Dices, Eye, EyeOff, Loader2, UserPlus, Users } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import api from "@/lib/axios";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  HOTEL_STAFF_ROLES,
  type StaffUser,
  type UserRoleValue,
} from "@/types/api";

const ROLE_META: Partial<
  Record<UserRoleValue, { label: string; variant: "info" | "warning" | "success" | "secondary" | "default" }>
> = {
  HOTEL_ADMIN: { label: "Hotel Admin", variant: "default" },
  MANAGER: { label: "Manager", variant: "info" },
  RECEPTION: { label: "Reception", variant: "success" },
  CLEANER: { label: "Housekeeping", variant: "warning" },
};

// Mirrors UserCreate in app/api/auth_router.py — note the 10-char password
// minimum (staff accounts, stricter than the 8-char login form floor).
const staffSchema = z.object({
  full_name: z
    .string()
    .trim()
    .min(2, "At least 2 characters")
    .max(255, "At most 255 characters"),
  email: z.string().email("Not a valid email"),
  password: z
    .string()
    .min(10, "At least 10 characters")
    .max(64, "At most 64 characters"),
  role: z.enum(HOTEL_STAFF_ROLES, { message: "Pick a role" }),
  phone: z.string().max(32, "At most 32 characters").optional(),
});

type StaffFormValues = z.infer<typeof staffSchema>;

export default function StaffSection() {
  const [staff, setStaff] = useState<StaffUser[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get<StaffUser[]>("/auth/users");
      setStaff(data);
    } catch {
      toast({ variant: "destructive", title: "Could not load your team" });
      setStaff([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-muted-foreground" />
            Team Members
            {staff !== null && (
              <Badge variant="secondary">{staff.length}</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Managers run operations; reception handles the desk; housekeeping
            keeps rooms sellable.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <UserPlus className="h-4 w-4" />
          Create Staff
        </Button>
      </CardHeader>
      <CardContent>
        {staff === null ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : staff.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No staff yet — create your first team member.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {staff.map((member) => {
                const meta = ROLE_META[member.role] ?? {
                  label: member.role,
                  variant: "secondary" as const,
                };
                return (
                  <TableRow
                    key={member.id}
                    className={member.is_active ? undefined : "opacity-50"}
                  >
                    <TableCell className="font-medium">
                      {member.full_name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {member.email}
                    </TableCell>
                    <TableCell>
                      <Badge variant={meta.variant}>{meta.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant={member.is_active ? "success" : "secondary"}
                      >
                        {member.is_active ? "Active" : "Disabled"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <CreateStaffDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void refresh();
        }}
      />
    </Card>
  );
}

function CreateStaffDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [showPassword, setShowPassword] = useState(false);

  const form = useForm<StaffFormValues>({
    resolver: zodResolver(staffSchema),
    defaultValues: {
      full_name: "",
      email: "",
      password: "",
      role: "RECEPTION",
      phone: "",
    },
  });

  useEffect(() => {
    if (open) {
      form.reset();
      setShowPassword(false);
    }
  }, [open, form]);

  const generatePassword = () => {
    const alphabet =
      "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%";
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    form.setValue(
      "password",
      Array.from(bytes, (b) => alphabet[b % alphabet.length]).join(""),
      { shouldValidate: true }
    );
    setShowPassword(true);
  };

  const onSubmit = async (values: StaffFormValues) => {
    try {
      // tenant_id is intentionally omitted: for hotel callers the backend
      // binds the account to the token's tenant, never the request body.
      await api.post("/auth/users", {
        email: values.email,
        password: values.password,
        full_name: values.full_name,
        role: values.role,
        phone: values.phone || null,
      });
      toast({ title: "Staff created successfully" });
      onCreated();
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 409) {
        form.setError("email", {
          message: "A user with this email already exists.",
        });
      } else if (isAxiosError(err) && err.response?.status === 403) {
        toast({
          variant: "destructive",
          title: "Not allowed",
          description: "You may only provision manager, reception and housekeeping roles.",
        });
      } else {
        toast({
          variant: "destructive",
          title: "Could not create the staff account",
        });
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create staff account</DialogTitle>
          <DialogDescription>
            The account is bound to your hotel and can sign in immediately.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
            noValidate
          >
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="full_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Full name</FormLabel>
                    <FormControl>
                      <Input placeholder="Saraa Bat" autoFocus {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Role</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select role" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="MANAGER">Manager</SelectItem>
                        <SelectItem value="RECEPTION">Reception</SelectItem>
                        <SelectItem value="CLEANER">Housekeeping</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        placeholder="saraa@hotel.mn"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phone</FormLabel>
                    <FormControl>
                      <Input placeholder="+976 9911 2233" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Temporary password</FormLabel>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <FormControl>
                        <Input
                          type={showPassword ? "text" : "password"}
                          autoComplete="new-password"
                          className="pr-10 font-mono"
                          {...field}
                        />
                      </FormControl>
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
                        aria-label={
                          showPassword ? "Hide password" : "Show password"
                        }
                        tabIndex={-1}
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={generatePassword}
                      title="Generate a strong password"
                    >
                      <Dices className="h-4 w-4" />
                      Generate
                    </Button>
                  </div>
                  <FormDescription>
                    10–64 characters. Share it over a secure channel.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={form.formState.isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Creating…
                  </>
                ) : (
                  "Create staff"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
