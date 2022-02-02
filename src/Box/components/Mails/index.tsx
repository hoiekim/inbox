import React, { useState, useContext, useEffect } from "react";
import { useQuery } from "react-query";

import {
  MailHeader,
  MailBody,
  SkeletonMail,
  KebabIcon,
  ReplyIcon,
  ShareIcon,
  TrashIcon,
  EmptyStarIcon,
  SolidStarIcon
} from "./components";

import { Context, Category, queryClient } from "src";

import { MailHeaderType, AccountsResponse } from "routes/lib/mails";

import "./index.scss";

import { marked } from "marked";

const MailsNotRendered = () => {
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch("/text/getting_started.md")
      .then((r) => r.text())
      .then((r) => setMessage(marked(r)));
  }, []);

  return (
    <div className="getting_started">
      <div dangerouslySetInnerHTML={{ __html: message }}></div>
    </div>
  );
};

const getMailsQueryUrl = (account: string, category: Category) => {
  let queryOption: string;

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

  const [activeMailId, setActiveMailId] = useState<any>({});
  const [openedKebab, setOpenedKebab] = useState("");

  useEffect(() => {
    setOpenedKebab("");
  }, [selectedAccount]);

  useEffect(() => {
    window.addEventListener("touchstart", () => setOpenedKebab(""));
  }, []);

  const queryUrl = getMailsQueryUrl(selectedAccount, selectedCategory);

  const getMails = () => fetch(queryUrl).then((r) => r.json());
  const query = useQuery<MailHeaderType[]>(queryUrl, getMails, {
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

  const requestDeleteMail = (mail: MailHeaderType) =>
    fetch(`/api/mails/${mail.id}`, { method: "DELETE" }).then((r) => r.json());

  const requestMarkRead = (mail: MailHeaderType) =>
    fetch(`/api/markRead/${mail.id}`).then((r) => r.json());

  const requestMarkSaved = (mail: MailHeaderType, unsave: boolean) => {
    const mailId = mail.id;
    const query = unsave ? "?unsave=1" : "";
    return fetch(`/api/markSaved/${mailId}${query}`).then((r) => r.json());
  };

  const removeAccountFromQueryData = () => {
    queryClient.setQueryData<AccountsResponse | undefined>(
      "/api/accounts",
      (oldData) => {
        if (!oldData) return oldData;

        const newData = { ...oldData };
        const key =
          selectedCategory === Category.SentMails ? "sent" : "received";
        newData[key].find((account, i) => {
          const found = account.key === selectedAccount;
          if (found) newData.received.splice(i, 1);
          return found;
        });

        return newData;
      }
    );
  };

  const markReadInQueryData = (mail: MailHeaderType) => {
    const mailId = mail.id;
    queryClient.setQueryData<AccountsResponse | undefined>(
      "/api/accounts",
      (oldData) => {
        if (!oldData) return oldData;

        const newData = { ...oldData };

        Object.values(Category).forEach((e) => {
          const queryUrl = getMailsQueryUrl(selectedAccount, e);

          queryClient.setQueryData<MailHeaderType[] | undefined>(
            queryUrl,
            (oldData) => {
              if (!oldData) return oldData;

              const newData = [...oldData];
              const foundData = newData.find((e) => e.id === mailId);
              if (foundData) foundData.read = true;

              return newData;
            }
          );
        });

        Object.values(newData).forEach((e) => {
          e.find((account) => {
            const { key, unread_doc_count } = account;
            const found = key === selectedAccount;
            if (found && unread_doc_count) account.unread_doc_count -= 1;
            return found;
          });
        });

        return newData;
      }
    );
  };

  const markSavedInQueryData = (mail: MailHeaderType, unsave: boolean) => {
    const mailId = mail.id;
    queryClient.setQueryData<AccountsResponse | undefined>(
      "/api/accounts",
      (oldData) => {
        if (!oldData) return oldData;
        const newData = { ...oldData };
        Object.values(newData).forEach((e) => {
          const found = e.find((f) => f.key === selectedAccount);
          if (found) {
            if (unsave) found.saved_doc_count--;
            else found.saved_doc_count++;
          }
        });
        return newData;
      }
    );

    Object.values(Category).forEach((e) => {
      const queryUrl = getMailsQueryUrl(selectedAccount, e);

      queryClient.setQueryData<MailHeaderType[] | undefined>(
        queryUrl,
        (oldData) => {
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
          if (e === Category.SavedMails) {
            if (foundIndex !== undefined) newData.splice(foundIndex, 1);
            else {
              let i = 0;
              while (new Date(newData[i]?.date) > new Date(mail.date)) i++;
              newData.splice(i, 0, { ...mail });
            }
          }

          return newData;
        }
      );
    });
  };

  if (query.isSuccess) {
    const mails = Array.isArray(query.data) ? query.data : [];

    const renderMail = (mail: MailHeaderType, i: number) => {
      const saved = mail.label === "saved";
      const isActive = !!activeMailId[mail.id];

      const onClickMailcard = () => {
        if (isActive) {
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
        if (!isActive) {
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
        if (!isActive) {
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

          queryClient.setQueryData<MailHeaderType[] | undefined>(
            queryUrl,
            (oldData) => {
              if (!oldData) return oldData;
              const newData = [...oldData];
              newData.splice(i, 1);
              if (!newData.length) removeAccountFromQueryData();
              return newData;
            }
          );
        }
      };

      const onClickStar = () => {
        requestMarkSaved(mail, saved);
        markSavedInQueryData(mail, saved);
      };

      const classes = ["mailcard"];

      if (!mail.read) classes.push("unread");
      if (!isWriterOpen) classes.push("shadow");
      if (saved) classes.push("star");

      let searchHighlight;

      if (mail.highlight) {
        searchHighlight = Object.values(mail.highlight).map((e) => {
          const __html = "..." + e.join("... ...") + "...";
          return <div dangerouslySetInnerHTML={{ __html }}></div>;
        });
      }

      if (!Array.isArray(mail.from.value)) mail.from.value = [mail.from.value];
      if (!Array.isArray(mail.to.value)) mail.to.value = [mail.to.value];

      const isKebabOpen = openedKebab === mail.id;

      return (
        <blockquote
          key={i}
          className={classes.join(" ")}
          onMouseLeave={() => setOpenedKebab("")}
        >
          <MailHeader
            mail={mail}
            isActive={isActive}
            onClick={onClickMailcard}
            onMouseLeave={() => setOpenedKebab("")}
          />
          {isActive ? (
            <MailBody mailId={mail.id} />
          ) : searchHighlight ? (
            <div className="search_highlight">{searchHighlight}</div>
          ) : null}
          <div
            className={
              "actionBox" +
              (isKebabOpen ? " open" : "") +
              (saved ? " saved" : "")
            }
          >
            {isKebabOpen ? (
              <>
                <div
                  className="iconBox cursor"
                  onClick={onClickStar}
                  onTouchStart={(e) => e.stopPropagation()}
                  onMouseEnter={() => setOpenedKebab(mail.id)}
                >
                  {saved ? (
                    <SolidStarIcon className="star" />
                  ) : (
                    <EmptyStarIcon />
                  )}
                </div>
                <div
                  className="iconBox cursor"
                  onClick={onClickReply}
                  onTouchStart={(e) => e.stopPropagation()}
                  onMouseEnter={() => setOpenedKebab(mail.id)}
                >
                  <ReplyIcon />
                </div>
                <div
                  className="iconBox cursor"
                  onClick={onClickShare}
                  onTouchStart={(e) => e.stopPropagation()}
                  onMouseEnter={() => setOpenedKebab(mail.id)}
                >
                  <ShareIcon />
                </div>
                <div
                  className="iconBox cursor"
                  onClick={onClickTrash}
                  onTouchStart={(e) => e.stopPropagation()}
                  onMouseEnter={() => setOpenedKebab(mail.id)}
                >
                  <TrashIcon />
                </div>
              </>
            ) : (
              <>
                {saved ? (
                  <div className={"iconBox cursor"} onClick={onClickStar}>
                    <SolidStarIcon className="star" />
                  </div>
                ) : (
                  <></>
                )}
                <div
                  className="iconBox cursor"
                  onClick={() => setOpenedKebab(mail.id)}
                >
                  <KebabIcon />
                </div>
              </>
            )}
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

  return <></>;
};

const Mails = () => {
  const { selectedAccount } = useContext(Context);
  if (!selectedAccount) return <MailsNotRendered />;
  else return <MailsRendered />;
};

export default Mails;
