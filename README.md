# minh-mobile

Chat with your minh agents from your phone, like the Claude app. No server, tunnel or install needed: messages go through a **private GitHub repo**.

```
phone app (GitHub Pages)  ──issues/comments──▶  private repo "minh-chat"  ◀──polls──  bridge (bun, on the server)  ──▶  minh hub
```

- A chat is an issue, and a message is a comment.
- The bridge posts replies as comments. It updates each reply while it grows, and asks for approvals with Approve/Deny buttons.
- Push notifications go straight from the bridge to Google's or Apple's push service. The phone saves its subscription in the repo.
- This project lives separately from clinemin and changes nothing there. The bridge loads clinemin's SDK from the folder you point it at.

Each person (each Windows account on the server) runs their own bridge, with their own repo and tokens.

## One-time setup (per person)

1. **Chat repo:** on your main GitHub account, create a **private** repo, for example `minh-chat`. Leave it empty.
2. **Bridge account (optional):** if the bridge should post as a second account, add that account under the repo's Settings > Collaborators and give it write access. Otherwise the bridge can use your main account. It tells its own comments apart by a hidden marker.
3. **Tokens:** create them at github.com > Settings > Developer settings.
   - **Phone token**, from your main account: a fine-grained token with **Only select repositories: minh-chat**, and **Issues** and **Contents** set to Read and write.
   - **Bridge token, if you skipped step 2:** a second token made the same way, also from your main account.
   - **Bridge token, if you use a second account:** a **classic** token from that account with the `repo` scope. Fine-grained tokens can't reach a repo the account is only a collaborator on. A classic token can reach everything that account can, so keep the account empty apart from this.
4. **Configure the bridge:** on the server, in this folder:
   ```
   bun install
   bun run setup
   ```
   It asks for the repo, the bridge token, who may chat, where clinemin is, and which folder chats work in. Settings go in `%USERPROFILE%\.minh-mobile\config.json`. If you added a second account, setup accepts the collaborator invitation for it.
5. **Start the bridge**, and keep it running like minh:
   ```
   bun run bridge
   ```
   - Only messages written after the first setup are answered.
   - It uses the provider and model minh used last, unless `provider` and `model` are set in config.json.
6. **Open the app on your phone:** go to the GitHub Pages link, enter the repo and the phone token, then add it to your home screen:
   - **Android, Chrome:** menu > Add to Home screen.
   - **iPhone, Safari:** Share > Add to Home Screen. Notifications need this on iOS 16.4 or later.

   Then open the drawer and tap **Turn on notifications**.

## Hosting the app

`app/` is plain static files with no build step. Publish it with GitHub Pages from a **public** repo; free Pages needs a public repo. Only the app code goes there; your chats stay in the private repo.

## Using it

- **New chat:** tap **+** and type. You can also open an issue on github.com.
- **Model and settings:** tap the model name under the message box to pick:
  - **Provider and model:** chosen from the ones set up in minh on the server. The bridge lists them in `.minh/options.json` when it starts and every 10 minutes.
  - **Mode:** Act or Plan.
  - **Tools:** run freely, or ask you each time.

  With no chat open, your picks apply to new chats. Inside a chat, they apply from your next message. A new model or tool setting starts a fresh minh session that carries over the chat's history.
- **Stop:** the stop button, or comment `/stop`.
- **Approvals:** when `autoApproveTools` is off, each tool call shows Approve/Deny. You can also comment `/approve <id>` or `/deny <id>`.
- **Archive a chat:** close the issue on github.com.
- **Delays:** about 3 to 6 seconds each way. Replies grow in steps every few seconds, not word by word.
- **Restarts:** the bridge picks up where it left off. A chat whose session stopped is revived from its transcript.
- **Open in minh:** a chat still open in a minh terminal window can't be continued from the phone until you close it there.

## Trying it locally (no tokens)

```
bun run fake-github      # pretend GitHub on :8790; any token works, the token is the login
bun run app              # app on http://localhost:8791
```

- **Bridge:** run `MINH_MOBILE_HOME=<some folder> bun run bridge`, with a config.json in that folder containing `"apiBase": "http://localhost:8790"`, `"token": "bot"` and `"allowedUsers": ["you"]`.
- **App:** use token `you` and set Advanced > API address to `http://localhost:8790`.

## Limits

- **GitHub API:** 5,000 requests an hour per token. Polls that find nothing new are free (ETag), and the bridge spaces out reply edits to stay below GitHub's limit on writes.
- **Security:** the phone token is stored in the browser on your phone. Anyone who can unlock the phone can use it, but only on the one repo.
