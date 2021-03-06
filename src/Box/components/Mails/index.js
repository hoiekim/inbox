import React, { useState, useContext, useEffect } from "react";
import { useQuery } from "react-query";

import MailBody from "./components/MailBody";
import ReplyIcon from "./components/ReplyIcon";
import TrashIcon from "./components/TrashIcon";
import SkeletonMail from "./components/SkeletonMail";

import { categories, Context, queryClient } from "../../..";

import "./index.scss";

import getting_started from "./components/getting_started.md";
import marked from "marked";

const MailsNotRendered = () => {
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(getting_started)
      .then((r) => r.text())
      .then((r) => setMessage(marked(r)));
  }, []);

  return (
    <div className="getting_started">
      <div dangerouslySetInnerHTML={{ __html: message }}></div>
    </div>
  );
};

const MailsRendered = () => {
  const {
    isWriterOpen,
    setReplyData,
    selectedAccount,
    setSelectedAccount,
    selectedCategory
  } = useContext(Context);

  const [activeMailId, setActiveMailId] = useState({});

  const selectedCategoryName = categories[selectedCategory];

  let queryUrl;

  if (selectedCategoryName === "sent") {
    queryUrl = `/api/mails/${selectedAccount}?sent=1`;
  } else if (selectedCategoryName === "new") {
    queryUrl = `/api/mails/${selectedAccount}?new=1`;
  } else {
    queryUrl = `/api/mails/${selectedAccount}`;
  }

  const queryOptions = {};
  const accountsData = queryClient.getQueryData("/api/accounts");

  const foundAccount = accountsData[selectedCategoryName].find((e) => {
    return e.key === selectedAccount;
  });

  if (!foundAccount) queryOptions.enabled = false;

  const getMails = () => fetch(queryUrl).then((r) => r.json());
  const query = useQuery(queryUrl, getMails, queryOptions);

  if (query.isIdle) {
    setSelectedAccount("");
    return <></>;
  }

  if (query.isLoading) {
    return (
      <div className="mails_container">
        <SkeletonMail />
        <SkeletonMail />
        <SkeletonMail />
      </div>
    );
  }

  if (query.error) {
    return (
      <div className="mails_container error">Mails List Request Failed</div>
    );
  }

  const requestDeleteMail = (mailId) =>
    fetch(`/api/mails/${mailId}`, { method: "DELETE" }).then((r) => r.json());

  const requestMarkRead = (mailId) =>
    fetch(`/api/markRead/${mailId}`).then((r) => r.json());

  const removeAccountFromQueryData = () => {
    queryClient.setQueryData("/api/accounts", (oldData) => {
      const newData = { ...oldData };

      const editByCategory = (category) => {
        let foundIndex;

        newData[category].find((account, i) => {
          const found = account.key === selectedAccount;
          if (found) foundIndex = i;
          return found;
        });

        if (foundIndex !== undefined) newData[category].splice(foundIndex, 1);
      };

      if (selectedCategoryName === "sent") editByCategory(selectedCategoryName);
      else for (const key in newData) key !== "sent" && editByCategory(key);

      return newData;
    });
  };

  const markReadInAccountsQueryData = () => {
    queryClient.setQueryData("/api/accounts", (oldData) => {
      const newData = { ...oldData };

      const editByCategory = (category) => {
        const foundData = newData[category].find((account) => {
          return account.key === selectedAccount;
        });

        foundData.unread_doc_count -= 1;

        if (!foundData.unread_doc_count) {
          let foundIndex;

          newData.new.find((account, i) => {
            const found = account.key === selectedAccount;
            if (found) foundIndex = i;
            return found;
          });

          newData.new.splice(foundIndex, 1);
        }
      };

      if (selectedCategoryName !== "sent") {
        for (const key in newData) key !== "sent" && editByCategory(key);
      }

      return newData;
    });
  };

  if (query.isSuccess) {
    const mails = Array.isArray(query.data) ? query.data : [];

    const renderMail = (mail, i) => {
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
      if (duration > 2 * 24 * 60 * 365) {
        duration = `${Math.floor(duration / (60 * 24 * 365))} years ago`;
      } else if (duration > 2 * 24 * 60 * 30.42) {
        duration = `${Math.floor(duration / (60 * 24 * 30.42))} months ago`;
      } else if (duration > 2 * 24 * 60 * 7) {
        duration = `${Math.floor(duration / (60 * 24 * 7))} weeks ago`;
      } else if (duration > 2 * 24 * 60) {
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
            requestMarkRead(mail.id);
            mail.read = true;
            markReadInAccountsQueryData();
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
        if (window.confirm("Do you want to delete this mail?")) {
          requestDeleteMail(mail.id);
          if (!mail.read) markReadInAccountsQueryData();

          queryClient.setQueryData(queryUrl, (oldData) => {
            const newData = [...oldData];
            newData.splice(i, 1);
            if (!newData.length) removeAccountFromQueryData();
            return newData;
          });
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
    };

    const result = mails.map(renderMail);

    return (
      <div className="mails_container">
        {result && result.length ? result : null}
      </div>
    );
  }
};

const Mails = () => {
  const { selectedAccount } = useContext(Context);
  if (!selectedAccount) return <MailsNotRendered />;
  else return <MailsRendered />;
};

export default Mails;
