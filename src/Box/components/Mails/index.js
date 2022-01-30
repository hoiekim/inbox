import React, { useState, useContext, useEffect } from "react";
import { useQuery } from "react-query";

import {
  MailBody,
  SkeletonMail,
  KebabIcon,
  ReplyIcon,
  ShareIcon,
  TrashIcon,
  EmptyStarIcon,
  SolidStarIcon
} from "./components";

import { Context, Category, queryClient } from "../../..";

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

const getMailsQueryUrl = (account, category) => {
  let queryOption;

  switch (category) {
    case Category.Search:
      return `/api/search/${encodeURIComponent(account)}`;
    case Category.SentMails:
      queryOption = "?sent=1";
      break;
    case Category.NewMails:
      queryOption = "?new=1";
      break;
    case Category.SavedMails:
      queryOption = "?saved=1";
      break;
    default:
      queryOption = "";
  }

  return `/api/mails/${account}${queryOption}`;
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
  const [openedKebab, setOpenedKebab] = useState("");

  useEffect(() => {
    setOpenedKebab("");
  }, [selectedAccount]);

  const queryUrl = getMailsQueryUrl(selectedAccount, selectedCategory);

  const getMails = () => fetch(queryUrl).then((r) => r.json());
  const query = useQuery(queryUrl, getMails, {
    onSuccess: (data) => {
      if (!data?.length) setSelectedAccount("");
    }
  });

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

  const requestDeleteMail = (mail) =>
    fetch(`/api/mails/${mail.id}`, { method: "DELETE" }).then((r) => r.json());

  const requestMarkRead = (mail) =>
    fetch(`/api/markRead/${mail.id}`).then((r) => r.json());

  const requestMarkSaved = (mail, unsave) => {
    const mailId = mail.id;
    const query = unsave ? "?unsave=1" : "";
    return fetch(`/api/markSaved/${mailId}${query}`).then((r) => r.json());
  };

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

      if (selectedCategory === Category.SentMails)
        editByCategory(selectedCategory);
      else for (const key in newData) key !== "sent" && editByCategory(key);

      return newData;
    });
  };

  const markReadInQueryData = (mail) => {
    const mailId = mail.id;
    queryClient.setQueryData("/api/accounts", (oldData) => {
      const newData = { ...oldData };

      for (const key in Category) {
        const queryUrl = getMailsQueryUrl(selectedAccount, Category[key]);

        queryClient.setQueryData(queryUrl, (oldData) => {
          if (!oldData) return oldData;

          const newData = [...oldData];
          const foundData = newData.find((e) => e.id === mailId);
          if (foundData) foundData.read = true;

          return newData;
        });
      }

      for (const key in newData) {
        const foundData = newData[key].find(
          (account) => account.key === selectedAccount
        );
        if (foundData?.unread_doc_count > 0) foundData.unread_doc_count -= 1;
      }

      return newData;
    });
  };

  const markSavedInQueryData = (mail, unsave) => {
    const mailId = mail.id;
    queryClient.setQueryData("/api/accounts", (oldData) => {
      const newData = { ...oldData };
      Object.values(newData).forEach((e) => {
        const found = e.find((f) => f.key === selectedAccount);
        if (found) {
          if (unsave) found.saved_doc_count--;
          else found.saved_doc_count++;
        }
      });
      return newData;
    });

    for (const key in Category) {
      const queryUrl = getMailsQueryUrl(selectedAccount, Category[key]);

      queryClient.setQueryData(queryUrl, (oldData) => {
        if (!oldData) return oldData;
        const newData = [...oldData];
        let foundIndex;
        newData.find((e, i) => {
          if (e.id === mailId) {
            foundIndex = i;
            e.label = unsave ? "" : "saved";
            return true;
          }
          return false;
        });
        if (Category[key] === Category.SavedMails) {
          if (foundIndex !== undefined) newData.splice(foundIndex, 1);
          else {
            let i = 0;
            while (new Date(newData[i]?.date) > new Date(mail.date)) i++;
            newData.splice(i, 0, { ...mail });
          }
        }

        return newData;
      });
    }
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

      let duration = (Date.now() - new Date(mail.date)) / (1000 * 60);
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

      const saved = mail.label === "saved";

      const onClickMailcard = () => {
        if (activeMailId[mail.id]) {
          const clonedActiveMailId = { ...activeMailId };
          delete clonedActiveMailId[mail.id];
          setActiveMailId(clonedActiveMailId);
        } else {
          if (!mail.read) {
            requestMarkRead(mail);
            markReadInQueryData(mail);
            mail.read = true;
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
        setReplyData({
          ...mail,
          subject: "Re: " + mail.subject,
          to: { address: selectedAccount }
        });
      };

      const onClickShare = () => {
        if (!activeMailId[mail.id]) {
          const clonedActiveMailId = { ...activeMailId, [mail.id]: true };
          setActiveMailId(clonedActiveMailId);
        }
        setReplyData({
          ...mail,
          subject: "Fwd: " + mail.subject,
          to: { address: "" }
        });
      };

      const onClickTrash = () => {
        if (window.confirm("Do you want to delete this mail?")) {
          requestDeleteMail(mail);
          if (!mail.read) markReadInQueryData(mail);

          queryClient.setQueryData(queryUrl, (oldData) => {
            const newData = [...oldData];
            newData.splice(i, 1);
            if (!newData.length) removeAccountFromQueryData();
            return newData;
          });
        }
      };

      const onClickStar = () => {
        requestMarkSaved(mail, saved);
        markSavedInQueryData(mail, saved);
      };

      const onClickKebab = () => {
        setOpenedKebab(openedKebab === mail.id ? "" : mail.id);
      };

      const classes = ["mailcard"];

      if (!mail.read) classes.push("unread");
      if (!isWriterOpen) classes.push("shadow");

      let searchHighlight;

      if (mail.highlight) {
        searchHighlight = Object.values(mail.highlight).map((e) => {
          const __html = "..." + e.join("... ...") + "...";
          return <div dangerouslySetInnerHTML={{ __html }}></div>;
        });
      }

      if (!Array.isArray(mail.from.value)) mail.from.value = [mail.from.value];
      if (!Array.isArray(mail.to.value)) mail.to.value = [mail.to.value];

      return (
        <blockquote key={i} className={classes.join(" ")}>
          <div className="header cursor" onClick={onClickMailcard}>
            <div className="mailcard-small content">{duration}</div>
            {activeMailId[mail.id] ? (
              <div className="mailcard-small content">
                {date}, {time}
              </div>
            ) : (
              <></>
            )}
            <div className="mailcard-small content">
              {"from: " +
                mail.from.value.map((e) => e.name || e.address).join(", ")}
            </div>
            {activeMailId[mail.id] ? (
              <div className="mailcard-small content">
                {"to: " +
                  mail.to.value.map((e) => e.name || e.address).join(", ")}
              </div>
            ) : (
              <></>
            )}
            <div className="mailcard-subject content">{mail.subject}</div>
          </div>
          {activeMailId[mail.id] ? (
            <MailBody mailId={mail.id} />
          ) : searchHighlight ? (
            <div className="search_highlight">{searchHighlight}</div>
          ) : null}
          <div className="actionBox">
            <div className="iconBox cursor" onClick={onClickStar}>
              {saved ? (
                <SolidStarIcon />
              ) : openedKebab === mail.id ? (
                <EmptyStarIcon />
              ) : (
                <></>
              )}
            </div>
            {openedKebab === mail.id ? (
              <>
                <div className="iconBox cursor" onClick={onClickReply}>
                  <ReplyIcon />
                </div>
                <div className="iconBox cursor" onClick={onClickShare}>
                  <ShareIcon />
                </div>
                <div className="iconBox cursor" onClick={onClickTrash}>
                  <TrashIcon />
                </div>
              </>
            ) : (
              <></>
            )}
            <div className="iconBox cursor" onClick={onClickKebab}>
              <KebabIcon />
            </div>
          </div>
          <div
            className={openedKebab === mail.id ? "popupBox" : "popupBox hide"}
            onClick={onClickKebab}
            onMouseLeave={onClickKebab}
          ></div>
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
