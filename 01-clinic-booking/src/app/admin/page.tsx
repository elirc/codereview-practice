import Link from "next/link";
import { requirePageActor } from "@/server/auth/page";
import { listAllProviders, listStaff } from "@/services/admin";
import { listClinics } from "@/services/clinics";
import { ApiForm, type FieldSpec } from "../_components/ApiForm";

const clinicFields: FieldSpec[] = [
  { name: "name", label: "Name", required: true },
  { name: "timezone", label: "Time zone (IANA)", required: true, defaultValue: "America/New_York" },
  { name: "minLeadMinutes", label: "Lead time (minutes)", type: "number", defaultValue: 60 },
  { name: "bookingHorizonDays", label: "Horizon (days)", type: "number", defaultValue: 90 },
];

export default async function AdminPage() {
  const actor = await requirePageActor("ADMIN");
  const clinics = await listClinics();
  const providers = await listAllProviders(actor);
  const staff = await listStaff(actor);
  const clinicOptions = clinics.map((clinic) => ({ value: clinic.id, label: clinic.name }));
  const account: FieldSpec[] = [
    { name: "email", label: "Email", type: "email", required: true },
    { name: "password", label: "Initial password", type: "password", required: true },
    { name: "clinicId", label: "Clinic", type: "select", options: clinicOptions, required: true },
  ];

  return (
    <>
      <h1>Administration</h1>

      <h2>Clinics</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Time zone</th>
            <th>Settings</th>
          </tr>
        </thead>
        <tbody>
          {clinics.map((clinic) => (
            <tr key={clinic.id}>
              <td>
                <Link href={`/staff/day?clinicId=${clinic.id}`}>{clinic.name}</Link>
              </td>
              <td>{clinic.timezone}</td>
              <td>
                <ApiForm
                  action={`/api/admin/clinics/${clinic.id}`}
                  method="PATCH"
                  submitLabel="Save"
                  fields={[
                    { name: "name", label: "Name", required: true, defaultValue: clinic.name },
                    {
                      name: "minLeadMinutes",
                      label: "Lead (min)",
                      type: "number",
                      defaultValue: clinic.minLeadMinutes,
                    },
                    {
                      name: "bookingHorizonDays",
                      label: "Horizon (days)",
                      type: "number",
                      defaultValue: clinic.bookingHorizonDays,
                    },
                  ]}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Add a clinic</h3>
      <ApiForm action="/api/admin/clinics" fields={clinicFields} submitLabel="Create clinic" />

      <h2>Providers</h2>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Clinic</th>
            <th>Login</th>
            <th>Profile</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((provider) => (
            <tr key={provider.id}>
              <td>
                <Link href={`/staff/providers/${provider.id}/availability`}>
                  {provider.displayName}
                </Link>
              </td>
              <td>{provider.clinic.name}</td>
              <td>{provider.user.email}</td>
              <td>
                <ApiForm
                  action={`/api/admin/providers/${provider.id}`}
                  method="PATCH"
                  submitLabel="Save"
                  fields={[
                    { name: "displayName", label: "Name", defaultValue: provider.displayName },
                    { name: "specialty", label: "Specialty", defaultValue: provider.specialty },
                    {
                      name: "active",
                      label: "Taking bookings",
                      type: "checkbox",
                      defaultValue: provider.active,
                    },
                  ]}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Add a provider</h3>
      <ApiForm
        action="/api/admin/providers"
        submitLabel="Create provider"
        fields={[
          ...account,
          { name: "displayName", label: "Display name", required: true },
          { name: "specialty", label: "Specialty", required: true },
        ]}
      />

      <h2>Staff</h2>
      <ul>
        {staff.map((user) => (
          <li key={user.id}>
            {user.email} <span className="muted">({user.clinic?.name})</span>
          </li>
        ))}
      </ul>
      <h3>Add a staff account</h3>
      <ApiForm action="/api/admin/staff" fields={account} submitLabel="Create staff account" />
    </>
  );
}
