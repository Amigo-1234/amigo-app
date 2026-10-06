import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { Bell, Compass, Mail } from "lucide-react";
import { MediaViewerProvider } from "./features/posts/MediaViewer";
import HomeScreen from "./screens/HomeScreen";
import { ComingSoonScreen } from "./screens/ComingSoonScreen";
import { AppShell } from "./shell/AppShell";
import { ComposerProvider } from "./state/composer";
import { NotificationsProvider, notificationsEnabled } from "./state/notifications";
import { PublishingProvider } from "./state/publishing";
import { SessionProvider, useSession, useViewer } from "./state/session";
import { profilesEnabled } from "./features/profile/links";
import { dataSource } from "./data";
import { ThemeProvider } from "./state/theme";
import { ToastProvider } from "./state/toast";
import { AmigoMark } from "./ui/Brand";

const PostScreen = lazy(() => import("./screens/PostScreen"));
const ProfileScreen = lazy(() => import("./screens/ProfileScreen"));
const FollowListScreen = lazy(() => import("./screens/FollowListScreen"));
const SettingsScreen = lazy(() => import("./screens/SettingsScreen"));
const ExploreScreen = lazy(() => import("./screens/ExploreScreen"));
const NotificationsScreen = lazy(() => import("./screens/NotificationsScreen"));
const AuthScreen = lazy(() => import("./screens/AuthScreen"));
const NotFoundScreen = lazy(() => import("./screens/NotFoundScreen"));
const SetPasswordScreen = lazy(() => import("./screens/SetPasswordScreen"));

function Splash() {
  return (
    <div className="splash" role="status" aria-label="Loading Amigo World">
      <AmigoMark size={44} />
    </div>
  );
}

/** Signed-out visitors get the auth screen at any URL; the URL is kept for after sign-in. */
function Root() {
  const session = useSession();
  if (session.status === "loading") return <Splash />;
  if (session.status === "recovery") {
    return (
      <Suspense fallback={<Splash />}>
        <SetPasswordScreen />
      </Suspense>
    );
  }
  if (session.status === "signedOut") {
    return (
      <Suspense fallback={<Splash />}>
        <AuthScreen />
      </Suspense>
    );
  }
  return (
    <ComposerProvider>
      <PublishingProvider>
        <NotificationsProvider>
          <MediaViewerProvider>
            <AppShell />
          </MediaViewerProvider>
        </NotificationsProvider>
      </PublishingProvider>
    </ComposerProvider>
  );
}

/** "/profile" is your own profile (or settings on backends without profiles). */
function MeRedirect() {
  const viewer = useViewer();
  return <Navigate to={profilesEnabled ? `/u/${viewer.handle}` : "/settings"} replace />;
}

const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { index: true, element: <HomeScreen /> },
      { path: "post/:postId", element: <PostScreen /> },
      { path: "profile", element: <MeRedirect /> },
      { path: "settings", element: <SettingsScreen /> },
      ...(profilesEnabled
        ? [
            { path: "u/:handle", element: <ProfileScreen /> },
            { path: "u/:handle/followers", element: <FollowListScreen kind="followers" /> },
            { path: "u/:handle/following", element: <FollowListScreen kind="following" /> },
          ]
        : []),
      {
        path: "explore",
        element: dataSource.discovery ? (
          <ExploreScreen />
        ) : (
          <ComingSoonScreen title="Explore" icon={Compass} body="Search for people and posts, and see what's happening across Amigo World." />
        ),
      },
      {
        path: "notifications",
        element: notificationsEnabled ? (
          <NotificationsScreen />
        ) : (
          <ComingSoonScreen title="Notifications" icon={Bell} body="Likes, replies and new followers will show up here." />
        ),
      },
      {
        path: "messages",
        element: <ComingSoonScreen title="Messages" icon={Mail} body="Private conversations with your people, one-on-one and in groups." />,
      },
      { path: "*", element: <NotFoundScreen /> },
    ],
  },
]);

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
