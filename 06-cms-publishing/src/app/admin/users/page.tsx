import { notFound } from "next/navigation";
import { requirePageUser } from "@/auth/page-guards";
import { can } from "@/auth/policy";
import { listUsers } from "@/services/users";
import { CreateUserForm, UserRowForm } from "../_components/user-forms";

export const metadata = { title: "Users" };

export default async function UsersPage() {
  const user = await requirePageUser();
  if (!can(user, "manageUsers")) notFound();
  const users = await listUsers();

  return (
    <>
      <h1>Users</h1>
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {users.map((row) => (
            <tr key={row.id}>
              <td>
                {row.email}
                {!row.active && <span className="muted"> (inactive)</span>}
              </td>
              <td>
                <UserRowForm
                  user={{ id: row.id, name: row.name, role: row.role, active: row.active }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Add a user</h2>
      <CreateUserForm />
    </>
  );
}
