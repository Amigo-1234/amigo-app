import { RouteError } from "./ui/ErrorBoundary";
import { lazy, Suspense, useState } from "react";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { Bell, Compass, Mail } from "lucide-react";
import { MediaViewerProvider } from "./features/posts/MediaViewer";
import HomeScreen from "./screens/HomeScreen";
import { ComingSoonScreen } from "./screens/ComingSoonScreen";
import { AppShell } from "./shell/AppShell";
import { ComposerProvider } from "./state/composer";
import { MessagesProvider } from "./state/messages";
import { MomentsProvider } from "./state/moments";
import { SecurityProvider } from "./state/security";
import { NotificationsProvider, notificationsEnabled } from "./state/notifications";
import { PublishingProvider } from "./state/publishing";
import { SessionProvider, useSession, useViewer } from "./state/session";
import { profilesEnabled } from "./features/profile/links";
import { dataSource } from "./data";
import { ThemeProvider } from "./state/theme";
import { ToastProvider } from "./state/toast";
import { LoadingScreen } from "./ui/Loader";
import { LegalGate } from "./features/legal/LegalGate";
import { onboardingFor, onboardingSteps } from "./features/onboarding/state";

const PostScreen = lazy(() => import("./screens/PostScreen"));
const ProfileScreen = lazy(() => import("./screens/ProfileScreen"));
const FollowListScreen = lazy(() => import("./screens/FollowListScreen"));
const SettingsScreen = lazy(() => import("./screens/SettingsScreen"));
const ExploreScreen = lazy(() => import("./screens/ExploreScreen"));
const NotificationsScreen = lazy(() => import("./screens/NotificationsScreen"));
const NotificationSettingsScreen = lazy(() => import("./screens/NotificationSettingsScreen"));
const WorldsScreen = lazy(() => import("./screens/WorldsScreen"));
const WorldScreen = lazy(() => import("./screens/WorldScreen"));
const SupportScreen = lazy(() => import("./screens/SupportScreen"));
const SupportRequestScreen = lazy(() => import("./screens/SupportRequestScreen"));
const SupportNewScreen = lazy(() => import("./screens/SupportNewScreen"));
const DevicesScreen = lazy(() => import("./screens/DevicesScreen"));
const BackupScreen = lazy(() => import("./screens/BackupScreen"));
const MessagesScreen = lazy(() => import("./screens/MessagesScreen"));
const AdminScreen = lazy(() => import("./screens/AdminScreen"));
const AuthScreen = lazy(() => import("./screens/AuthScreen"));
const NotFoundScreen = lazy(() => import("./screens/NotFoundScreen"));
const SetPasswordScreen = lazy(() => import("./screens/SetPasswordScreen"));
const LegalScreen = lazy(() => import("./screens/LegalScreen"));
const Onboarding = lazy(() => import("./features/onboarding/Onboarding").then((m) => ({ default: m.Onboarding })));
const InterestsScreen = lazy(() => import("./screens/InterestsScreen"));
const CreatorProgrammeScreen = lazy(() => import("./screens/CreatorProgrammeScreen"));
const BookmarksScreen = lazy(() => import("./screens/BookmarksScreen"));
const BlockedScreen = lazy(() => import("./screens/BlockedScreen"));
const BusinessScreen = lazy(() => import("./screens/BusinessScreen"));
const BusinessProfileScreen = lazy(() => import("./screens/BusinessProfileScreen"));
const BusinessManageScreen = lazy(() => import("./screens/BusinessManageScreen"));

function Splash() {
  return <LoadingScreen />;
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
    <LegalGate>
    <ComposerProvider>
      <PublishingProvider>
        <NotificationsProvider>
          <MessagesProvider>
            <SecurityProvider>
              <MediaViewerProvider>
                <MomentsProvider>
                  <ShellOrOnboarding />
                </MomentsProvider>
              </MediaViewerProvider>
            </SecurityProvider>
          </MessagesProvider>
        </NotificationsProvider>
      </PublishingProvider>
    </ComposerProvider>
    </LegalGate>
  );
}

/** A new account's joining steps (see features/onboarding), then the app. */
function ShellOrOnboarding() {
  const viewer = useViewer();
  const [progress, setProgress] = useState(() => onboardingFor(viewer.id, onboardingSteps(viewer.emailVerified)[0]));
  if (progress)
    return (
      <Suspense fallback={<Splash />}>
        <Onboarding initial={progress} onDone={() => setProgress(null)} />
      </Suspense>
    );
  return <AppShell />;
}

/** "/profile" is your own profile (or settings on backends without profiles). */
function MeRedirect() {
  const viewer = useViewer();
  return <Navigate to={profilesEnabled ? `/u/${viewer.handle}` : "/settings"} replace />;
}

const router = createBrowserRouter([
  // Legal pages are public: readable signed out (e.g. from the sign-up form) and signed in.
  {
    path: "legal/:slug?",
    errorElement: <RouteError />,
    element: (
      <Suspense fallback={<Splash />}>
        <LegalScreen />
      </Suspense>
    ),
  },
  {
    element: <Root />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomeScreen /> },
      { path: "post/:postId", element: <PostScreen /> },
      { path: "profile", element: <MeRedirect /> },
      { path: "settings", element: <SettingsScreen /> },
      ...(dataSource.creatorProgramme ? [{ path: "settings/monetization", element: <CreatorProgrammeScreen /> }] : []),
      ...(dataSource.interests ? [{ path: "settings/interests", element: <InterestsScreen /> }] : []),
      ...(notificationsEnabled ? [{ path: "settings/notifications", element: <NotificationSettingsScreen /> }] : []),
      ...(dataSource.postTools ? [{ path: "bookmarks", element: <BookmarksScreen /> }] : []),
      ...(dataSource.blocking ? [{ path: "settings/blocked", element: <BlockedScreen /> }] : []),
      // Business pages live at /b/:handle, apart from people's /u/:handle. The screens show
      // "not available" until an admin switches businesses on.
      ...(dataSource.business
        ? [
            { path: "business", element: <BusinessScreen /> },
            { path: "b/:handle", element: <BusinessProfileScreen /> },
            { path: "settings/business", element: <BusinessManageScreen /> },
          ]
        : []),
      ...(dataSource.messages?.security
        ? [
            { path: "settings/devices", element: <DevicesScreen /> },
            { path: "settings/backup", element: <BackupScreen /> },
          ]
        : []),
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
      ...(dataSource.worlds
        ? [
            { path: "worlds", element: <WorldsScreen /> },
            { path: "worlds/:slug", element: <WorldScreen /> },
          ]
        : []),
      ...(dataSource.support
        ? [
            { path: "support", element: <SupportScreen /> },
            { path: "support/new", element: <SupportNewScreen /> },
            { path: "support/:requestId", element: <SupportRequestScreen /> },
          ]
        : []),
      // /admin is guarded in the screen and, for real, by the backend on every admin call.
      ...(dataSource.admin ? [{ path: "admin/:section?", element: <AdminScreen /> }] : []),
      {
        path: "notifications",
        element: notificationsEnabled ? (
          <NotificationsScreen />
        ) : (
          <ComingSoonScreen title="Notifications" icon={Bell} body="Likes, replies and new followers will show up here." />
        ),
      },
      ...(dataSource.messages
        ? [
            { path: "messages", element: <MessagesScreen /> },
            { path: "messages/:conversationId", element: <MessagesScreen /> },
          ]
        : [
            {
              path: "messages",
              element: <ComingSoonScreen title="Messages" icon={Mail} body="Private one-to-one conversations with your people." />,
            },
          ]),
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
