// TODO: wire up a real email provider (e.g. SES, Postmark, SendGrid). Until then this just
// logs what would be sent so instance invites still work end-to-end in development.
export type InviteEmail = {
  to: string;
  instanceLabel: string;
};

export async function sendInviteEmail({ to, instanceLabel }: InviteEmail): Promise<void> {
  console.log(
    `[email:stub] Would send invite email to "${to}" for instance "${instanceLabel}": ` +
      `"You've been invited to join ${instanceLabel} on Flux. Register at the app with this email to join."`
  );
}
