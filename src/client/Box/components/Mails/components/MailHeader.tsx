import { ComponentProps, useContext } from "react";
import { Context, getDateForMailHeader } from "client";
import { MailAddressValueType, MailHeaderData } from "common";

export interface MailHeaderProps extends ComponentProps<"div"> {
  mail: MailHeaderData;
  isActive: boolean;
}

const MailHeader = (props: MailHeaderProps) => {
  const { mail, isActive, onClick, onMouseLeave } = props;
  const { isWriterOpen } = useContext(Context);
  const { date, time, duration } = getDateForMailHeader(new Date(mail.date));

  const classes = ["mailcard"];

  if (!mail.read) classes.push("unread");
  if (mail.saved) classes.push("star");
  if (!isWriterOpen) classes.push("shadow");

  const cc = "cc" in mail ? mail.cc : undefined;
  const bcc = "bcc" in mail ? mail.bcc : undefined;

  if (cc?.value && !Array.isArray(cc.value)) cc.value = [cc.value];
  if (bcc?.value && !Array.isArray(bcc.value)) bcc.value = [bcc.value];

  return (
    <div
      className="header cursor"
      onClick={onClick}
      onMouseLeave={onMouseLeave}
    >
      <div className="mailcard-small content">{duration}</div>
      <div className={"mailcard-small content" + (isActive ? "" : " closed")}>
        {date}, {time}
      </div>
      <div className="mailcard-small content">
        {"from: " +
          mail?.from?.value?.map((e) => e?.name || e?.address).join(", ")}
      </div>
      <div className={"mailcard-small content" + (isActive ? "" : " closed")}>
        {"to: " + mail?.to?.value?.map((e) => e?.name || e?.address).join(", ")}
      </div>
      {cc && cc.value ? (
        <div className={"mailcard-small content" + (isActive ? "" : " closed")}>
          {"cc: " +
            (cc.value as MailAddressValueType[])
              .map((e) => e?.name || e?.address)
              .join(", ")}
        </div>
      ) : (
        <></>
      )}
      {bcc && bcc.value ? (
        <div className={"mailcard-small content" + (isActive ? "" : " closed")}>
          {"bcc: " +
            (bcc.value as MailAddressValueType[])
              .map((e) => e?.name || e?.address)
              .join(", ")}
        </div>
      ) : (
        <></>
      )}
      <div className="mailcard-subject content">{mail.subject}</div>
    </div>
  );
};

export default MailHeader;
