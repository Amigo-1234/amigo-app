import { useEffect, useRef, useState, type FormEvent } from "react";
import { Camera } from "lucide-react";
import { BIO_MAX_LENGTH, HANDLE_PATTERN, NAME_MAX_LENGTH, ProfileError, dataSource, type Profile, type ProfileUpdate } from "../../data";
import { prepareAvatar, type PreparedImage } from "../../lib/image";
import { useViewer } from "../../state/session";
import { useToast } from "../../state/toast";
import { Avatar } from "../../ui/Avatar";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import "./EditProfileSheet.css";

type HandleState = "unchanged" | "invalid" | "checking" | "available" | "taken";

export function EditProfileSheet({
  open,
  profile,
  onClose,
  onSaved,
}: {
  open: boolean;
  profile: Profile;
  onClose: () => void;
  onSaved: (handleChanged: boolean, handle: string) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} label="Edit profile" fullscreenOnMobile>
      <EditProfileForm profile={profile} onClose={onClose} onSaved={onSaved} />
    </Sheet>
  );
}

function EditProfileForm({ profile, onClose, onSaved }: { profile: Profile; onClose: () => void; onSaved: (handleChanged: boolean, handle: string) => void }) {
  const viewer = useViewer();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(profile.name);
  const [handle, setHandle] = useState(profile.handle);
  const [bio, setBio] = useState(profile.bio);
  // undefined = unchanged, null = remove, image = replace
  const [avatar, setAvatar] = useState<PreparedImage | null | undefined>(undefined);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [handleState, setHandleState] = useState<HandleState>("unchanged");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanHandle = handle.trim().toLowerCase();
  const handleChanged = cleanHandle !== profile.handle;

  // Validate the username locally, then check availability after a short pause.
  useEffect(() => {
    if (!handleChanged) return setHandleState("unchanged");
    if (!HANDLE_PATTERN.test(cleanHandle)) return setHandleState("invalid");
    setHandleState("checking");
    let cancelled = false;
    const t = setTimeout(() => {
      dataSource.profiles
        ?.isHandleAvailable(cleanHandle, viewer.id)
        .then((ok) => !cancelled && setHandleState(ok ? "available" : "taken"))
        .catch(() => !cancelled && setHandleState("available")); // the save itself is the final check
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [cleanHandle, handleChanged, viewer.id]);

  const nameOk = name.trim().length > 0 && name.trim().length <= NAME_MAX_LENGTH;
  const bioOk = bio.length <= BIO_MAX_LENGTH;
  const handleOk = handleState === "unchanged" || handleState === "available";
  const dirty = name.trim() !== profile.name || bio.trim() !== profile.bio || handleChanged || avatar !== undefined;
  const canSave = dirty && nameOk && bioOk && handleOk && !saving && !avatarBusy;

  async function pickAvatar(file: File | undefined) {
    if (!file) return;
    setAvatarBusy(true);
    setError(null);
    try {
      setAvatar(await prepareAvatar(file));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAvatarBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave || !dataSource.profiles) return;
    setSaving(true);
    setError(null);
    const update: ProfileUpdate = {};
    if (name.trim() !== profile.name) update.name = name.trim();
    if (bio.trim() !== profile.bio) update.bio = bio.trim();
    if (handleChanged) update.handle = cleanHandle;
    if (avatar !== undefined) update.avatar = avatar;
    try {
      await dataSource.profiles.updateProfile(viewer.id, update);
      toast("Profile updated");
      onSaved(handleChanged, cleanHandle);
    } catch (err) {
      if (err instanceof ProfileError && err.code === "handle-taken") setHandleState("taken");
      else if (err instanceof ProfileError && err.code === "handle-invalid") setHandleState("invalid");
      else setError("We couldn't save your profile. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const avatarSrc = avatar === undefined ? profile.avatarUrl : avatar?.dataUrl ?? null;
  const handleHint: Record<HandleState, string> = {
    unchanged: "",
    invalid: "3–24 characters: lowercase letters, numbers and underscores.",
    checking: "Checking…",
    available: "Available",
    taken: "That username is taken.",
  };

  return (
    <form className="edit-profile" onSubmit={submit} aria-label="Edit profile" noValidate>
      <div className="composer__bar">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <span className="composer__bar-title">Edit profile</span>
        <Button type="submit" size="sm" disabled={!canSave} loading={saving}>
          Save
        </Button>
      </div>

      <div className="edit-profile__body">
        <div className="edit-profile__avatar">
          <button type="button" className="edit-profile__avatar-btn" onClick={() => fileRef.current?.click()} aria-label="Change profile photo" disabled={avatarBusy}>
            <Avatar name={name || profile.name} src={avatarSrc} seed={profile.id} size="xl" />
            <span className="edit-profile__avatar-overlay" aria-hidden="true">
              <Camera size={22} />
            </span>
          </button>
          <div className="edit-profile__avatar-actions">
            <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()} loading={avatarBusy}>
              Change photo
            </Button>
            {avatarSrc && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setAvatar(null)}>
                Remove
              </Button>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => pickAvatar(e.target.files?.[0])} />
        </div>

        <label className="field">
          <span className="field__label">Name</span>
          <input className="field__input" value={name} maxLength={NAME_MAX_LENGTH} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </label>

        <label className="field">
          <span className="field__label">Username</span>
          <span className={`edit-profile__handle${handleState === "invalid" || handleState === "taken" ? " is-invalid" : ""}`}>
            <span aria-hidden="true">@</span>
            <input
              className="field__input"
              value={handle}
              maxLength={24}
              onChange={(e) => setHandle(e.target.value.replace(/\s/g, ""))}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={handleState === "invalid" || handleState === "taken"}
              aria-describedby="handle-hint"
            />
          </span>
          <span id="handle-hint" className={`field__hint field__hint--${handleState}`} aria-live="polite">
            {handleHint[handleState]}
          </span>
        </label>

        <label className="field">
          <span className="field__label">
            Bio <span className="field__count">{bio.length}/{BIO_MAX_LENGTH}</span>
          </span>
          <textarea
            className="field__input edit-profile__bio"
            value={bio}
            rows={3}
            onChange={(e) => setBio(e.target.value)}
            aria-invalid={!bioOk}
            placeholder="A little about you"
          />
        </label>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
