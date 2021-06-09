import React, { useState, useContext } from "react";
import { useQuery, useMutation } from "react-query";

import MailBody from "./components/MailBody";
import ReplyIcon from "./components/ReplyIcon";
import TrashIcon from "./components/TrashIcon";

import { Context } from "../../..";
import { mailCache } from "../..";

import "./index.scss";

const MailsNotRendered = () => {
  return <div className="mails_container">Please Select Account</div>;
};

const MailsRendered = ({ selectedAccount }) => {
  const { isWriterOpen, setReplyData, fetchAccounts, setFetchAccounts } =
    useContext(Context);

  const [activeMailId, setActiveMailId] = useState({});

  const getMails = () =>
    fetch(`/api/mails/${selectedAccount}`).then((r) => r.json());
  const query = useQuery("getMails_" + selectedAccount, getMails);

  const deleteMail = (mailId) =>
    fetch(`/api/mails/${mailId}`, { method: "DELETE" }).then((r) => r.json());
  const mutation = useMutation(deleteMail, { onSuccess: query.refetch });

  const markRead = (mailId) =>
    fetch(`/api/markRead/${mailId}`).then((r) => r.json());

  if (query.isLoading) {
    return <div className="mails_container">Loading Mails List...</div>;
  }

  if (query.error) {
    return <div className="mails_container">Mails List Request Failed</div>;
  }

  if (query.isSuccess) {
    const mails = Array.isArray(query.data) ? query.data : [];

    const MailsList = () => {
      const result = mails.map((mail, i) => {
        const date = new Date(mail.date).toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric"
        });

        const time = new Date(mail.date).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit"
        });

        let duration =
          (Number(Date.now()) - Number(new Date(mail.date))) / (1000 * 60);
        if (duration > 2 * 24 * 60) {
          duration = `${Math.floor(duration / (60 * 24))} days ago`;
        } else if (duration > 2 * 60) {
          duration = `${Math.floor(duration / 60)} hours ago`;
        } else if (duration > 2) {
          duration = `${Math.floor(duration)} minutes ago`;
        } else {
          duration = "just now";
        }

        const onClickMailcard = () => {
          if (activeMailId[mail.id]) {
            const clonedActiveMailId = { ...activeMailId };
            delete clonedActiveMailId[mail.id];
            setActiveMailId(clonedActiveMailId);
          } else {
            if (!mail.read) {
              markRead(mail.id);
              mail.read = true;
              setFetchAccounts(fetchAccounts + 1);
            }
            const clonedActiveMailId = { ...activeMailId, [mail.id]: true };
            setActiveMailId(clonedActiveMailId);
          }
        };

        const onClickReply = () => {
          if (!activeMailId[mail.id]) {
            const clonedActiveMailId = { ...activeMailId, [mail.id]: true };
            setActiveMailId(clonedActiveMailId);
          }
          setReplyData({ ...mail, to: { address: selectedAccount } });
        };

        const onClickTrash = () => {
          const sure = window.confirm("Do you want to delete this mail?");
          if (sure) {
            mutation.mutate(mail.id);
            if (mails.length === 1) setFetchAccounts(fetchAccounts + 1);
          }
        };

        const classes = ["mailcard"];

        if (!mail.read) classes.push("unread");
        if (!isWriterOpen) classes.push("shadow");

        return (
          <blockquote key={i} className={classes.join(" ")}>
            <div className="header cursor" onClick={onClickMailcard}>
              <div className="mailcard-small content">{duration}</div>
              <div className="mailcard-small content">
                {date}, {time}
              </div>
              <div className="mailcard-small content">
                {"from: " + mail.from?.text}
              </div>
              <div className="mailcard-small content">
                {"to: " + mail.to?.text}
              </div>
              <div className="mailcard-subject content">{mail.subject}</div>
            </div>
            {activeMailId[mail.id] ? <MailBody mailId={mail.id} /> : null}
            <div className="actionBox">
              <div className="iconBox">
                <ReplyIcon className="cursor" onClick={onClickReply} />
              </div>
              <div className="iconBox">
                <TrashIcon className="cursor" onClick={onClickTrash} />
              </div>
            </div>
          </blockquote>
        );
      });

      return result;
    };

    return (
      <div className="mails_container">
        <MailsList />
      </div>
    );
  }
};

const Mails = ({ selectedAccount }) => {
  if (!selectedAccount) return <MailsNotRendered />;
  else return <MailsRendered selectedAccount={selectedAccount} />;
};

export default Mails;
