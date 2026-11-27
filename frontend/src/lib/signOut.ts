/**
 * ADR-109: sign-out always comes back to the sign-in page (`/?signed-out=1`); the server ends the identity provider's session
 * itself. `provider-session` is added when the provider did not confirm the end of its own session.
 */
export type SignOutNotice = { kind: 'success' | 'warning'; text: string };

export function signOutNotice(search: string): SignOutNotice | null {
  const query = new URLSearchParams(search);
  if (!query.has('signed-out')) return null;
  if (query.has('provider-session'))
    return { kind: 'warning', text: 'تم تسجيل الخروج من تمركز، لكن تعذر إنهاء جلسة مزود الهوية؛ أغلق المتصفح إن كان الجهاز مشتركاً.' };
  return { kind: 'success', text: 'تم تسجيل الخروج بنجاح' };
}
