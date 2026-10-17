import { useState } from "react";
import { NavLink, useParams } from "react-router";
import { FileText, Flag, HandHeart, LayoutDashboard, Orbit, ShieldAlert, Sparkles, UsersRound } from "lucide-react";
import { dataSource } from "../data";
import { AdminLegal, AdminMonetization } from "../features/admin/AdminPlatform";
import { AdminContentReports, AdminSuspensions } from "../features/admin/AdminModeration";
import { useIsAdmin } from "../features/admin/useAdmin";
import { AdminOverview, AdminPlaceholder, AdminWorlds } from "../features/admin/AdminSections";
import { SupportAdmin } from "../features/admin/SupportAdmin";
import { AdminUsers } from "../features/admin/AdminUsers";
import { AdminMessageReports } from "../features/admin/AdminMessageReports";
import { AdminMomentReports } from "../features/admin/AdminMomentReports";
import { ScreenHeader } from "../shell/ScreenHeader";
import { Skeleton } from "../ui/Skeleton";
import { StateMessage } from "../ui/StateMessage";
import "../features/support/Support.css";
import "../features/admin/Admin.css";

/** Future modules (campaigns, paid placement, creator plans…) get an entry here. */
const SECTIONS = [
  { id: "", label: "Overview", icon: LayoutDashboard },
  { id: "support", label: "Support Hub", icon: HandHeart },
  { id: "worlds", label: "Worlds", icon: Orbit },
  { id: "users", label: "Users", icon: UsersRound },
  { id: "reports", label: "Reports", icon: Flag },
  ...(dataSource.admin?.monetization ? [{ id: "monetization", label: "Monetization", icon: Sparkles }] : []),
  ...(dataSource.admin?.legal ? [{ id: "legal", label: "Legal", icon: FileText }] : []),
];

export default function AdminScreen() {
  const admin = useIsAdmin();
  const { section = "" } = useParams();
  const [suspendKey, setSuspendKey] = useState(0);

  if (admin === null) {
    return (
      <>
        <ScreenHeader title="Admin" />
        <div className="admin-body" aria-busy="true">
          <Skeleton width="60%" height={18} />
        </div>
      </>
    );
  }
  // Non-admins get the same answer as any unknown page — nothing to probe.
  if (!admin) {
    return (
      <>
        <ScreenHeader title="Not found" />
        <StateMessage icon={<ShieldAlert size={24} />} title="This page doesn't exist" body="Check the link, or head back home." />
      </>
    );
  }

  return (
    <>
      <ScreenHeader title="Admin">
        <nav className="tabs admin-tabs" aria-label="Admin sections">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <NavLink key={id} to={id ? `/admin/${id}` : "/admin"} end className="tab tab--link admin-tab">
              <Icon size={16} aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </ScreenHeader>
      <div className="admin-body">
        {section === "" && <AdminOverview />}
        {section === "support" && <SupportAdmin />}
        {section === "worlds" && <AdminWorlds />}
        {section === "users" && <AdminUsers />}
        {section === "monetization" && dataSource.admin?.monetization && <AdminMonetization />}
        {section === "legal" && dataSource.admin?.legal && <AdminLegal />}
        {section === "reports" && (
          <>
            <AdminMomentReports />
            <AdminMessageReports />
            {dataSource.admin?.moderation ? (
              <>
                <AdminContentReports onSuspended={() => setSuspendKey((k) => k + 1)} />
                <AdminSuspensions refreshKey={suspendKey} />
                <AdminPlaceholder
                  title="Support Hub reports"
                  body="Reports on Support Hub requests are reviewed in Support Hub → Reports."
                  link={{ to: "/admin/support?tab=reports", label: "Open Support Hub reports" }}
                />
              </>
            ) : (
              <AdminPlaceholder
                title="Other reports"
                body="Reporting posts and people isn't built yet. Reports on Support Hub requests are reviewed in Support Hub → Reports."
                link={{ to: "/admin/support?tab=reports", label: "Open Support Hub reports" }}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}
