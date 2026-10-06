# Proposed Firestore rules (not applied)

Goal: stop exposing `users/*` (emails) and stop anonymous reads, while the
legacy app keeps working for signed-in people until cutover.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }

    match /posts/{postId} {
      allow read: if signedIn();
      allow create: if signedIn() && request.resource.data.authorId == request.auth.uid;
      allow update: if signedIn();          // likes / comment counters (legacy client design)
      allow delete: if false;
      match /comments/{commentId} {
        allow read: if signedIn();
        allow create: if signedIn() && request.resource.data.authorId == request.auth.uid;
        allow update, delete: if false;
      }
    }

    match /users/{uid} {
      // Emails live here, so only the owner may read their own doc.
      allow read, write: if signedIn() && request.auth.uid == uid;
      match /following/{target} { allow read: if signedIn(); allow write: if request.auth.uid == uid; }
      match /followers/{follower} { allow read: if signedIn(); allow write: if request.auth.uid == follower; }
    }

    match /globalChat/{id} {
      allow read: if signedIn();
      allow create: if signedIn() && request.resource.data.authorId == request.auth.uid;
    }
  }
}
```

## Impact

| Who | What changes |
| --- | --- |
| Signed-out visitors | Can't read anything (they couldn't use the app signed out anyway). |
| Old prototype, Friends page | The user list and search stop working: it reads every `users` doc. |
| Phase 1 app, Firebase build | "People to follow" rail is empty. Feed, likes and replies are unaffected. |
| Migration | Use `--source admin` (the Admin SDK ignores rules). `--source rest` stops working. |
| Other apps writing to this project | Unknown. 8 posts have shapes this repo never wrote; check them first. |

Apply by deploying through the Firebase console (Firestore → Rules) after the
impact above has been accepted. Roll back by restoring the previous rules,
which the console keeps in its history.
