export const formatAddressList = (value?: any): string => {
  if (!value) return "NIL";
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .map(({ name = "", address = "" }) => {
      const [local, domain] = address.split("@");
      return `("${name}" NIL "${local}" "${domain}")`;
    })
    .join(" ");
};

export const formatHeaders = (mail: any): string => {
  const headers: string[] = [];
  if (mail.subject) headers.push(`Subject: ${mail.subject}`);
  if (mail.date) headers.push(`Date: ${new Date(mail.date).toUTCString()}`);
  if (mail.from?.text) headers.push(`From: ${mail.from.text}`);
  if (mail.to?.text) headers.push(`To: ${mail.to.text}`);
  if (mail.cc?.text) headers.push(`Cc: ${mail.cc.text}`);
  if (mail.bcc?.text) headers.push(`Bcc: ${mail.bcc.text}`);
  return headers.join("\r\n");
};
