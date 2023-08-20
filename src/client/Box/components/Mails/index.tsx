import {
  useState,
  useContext,
  useEffect,
  Dispatch,
  SetStateAction
} from "react";
import { useQuery } from "react-query";
import { marked } from "marked";
import { MailHeaderData, MailSearchResult } from "common";

import {
  HeadersGetResponse,
  MarkMailPostBody,
  MarkMailPostResponse,
  SearchGetResponse,
  MailDeleteResponse
} from "server";

import {
  MailHeader,
  MailBody,
  SkeletonMail,
  KebabIcon,
  ReplyIcon,
  ShareIcon,
  TrashIcon,
  EmptyStarIcon,
  SolidStarIcon,
  RobotIcon
} from "./components";

import { Context, Category, QueryCache, call } from "client";
import { AccountsCache } from "client/Box/components/Accounts";

import "./index.scss";

const GettingStarted = () => {
  const queryUrl = "/text/getting_started.md";

  const fetchMessage = () =>
    fetch(queryUrl)
      .then((r) => r.text())
      .then((r) => marked(r));

  const query = useQuery<string>(queryUrl, fetchMessage);

  return (
    <div className="getting_started">
      <div dangerouslySetInnerHTML={{ __html: query.data || "" }} />
    </div>
  );
};

const getMailsQueryUrl = (account: string, category: Category) => {
  let queryOption: string;

  switch (category) {
    case Category.Search:
      return `/api/mails/search/${encodeURIComponent(account)}`;
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

  return `/api/mails/headers/${account}${queryOption}`;
};

export class MailsCache extends QueryCache<MailHeaderData[]> {
  constructor(account: string, category: Category) {
    super(getMailsQueryUrl(account, category));
  }
}

interface RenderedMailProps {
  mail: MailHeaderData | MailSearchResult;
  i: number;
  activeMailId: ActiveMailMap;
  setActiveMailId: Dispatch<SetStateAction<ActiveMailMap>>;
  requestMarkRead: (mail: MailHeaderData) => Promise<any>;
  markReadInQueryData: (mail: MailHeaderData) => void;
  setReplyData: Dispatch<SetStateAction<any>>;
  requestDeleteMail: (mail: MailHeaderData) => Promise<any>;
  selectedAccount: string;
  accountsCache: AccountsCache;
  selectedCategory: Category;
  removeAccountFromQueryData: () => void;
  requestMarkSaved: (mail: MailHeaderData, saved: boolean) => void;
  markSavedInQueryData: (mail: MailHeaderData, saved: boolean) => void;
  isWriterOpen: boolean;
  openedKebab: string;
  setOpenedKebab: Dispatch<SetStateAction<string>>;
}

const RenderedMail = ({
  mail,
  i,
  activeMailId,
  setActiveMailId,
  requestMarkRead,
  markReadInQueryData,
  setReplyData,
  requestDeleteMail,
  selectedAccount,
  accountsCache,
  selectedCategory,
  removeAccountFromQueryData,
  requestMarkSaved,
  markSavedInQueryData,
  isWriterOpen,
  openedKebab,
  setOpenedKebab
}: RenderedMailProps) => {
  const saved = "label" in mail && mail.label === "saved";
  const isActive = !!activeMailId[mail.id];

  const [isSummaryOpen, setIsSummaryOpen] = useState(false);

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
    setReplyData({ ...mail, to: { address: selectedAccount } });
  };

  const onClickShare = () => {
    if (!isActive) {
      const clonedActiveMailId = { ...activeMailId, [mail.id]: true };
      setActiveMailId(clonedActiveMailId);
    }
    setReplyData({ ...mail, to: { address: "" } });
  };

  const onClickTrash = () => {
    if (window.confirm("Do you want to delete this mail?")) {
      requestDeleteMail(mail);

      accountsCache.set((oldData) => {
        if (!oldData) return oldData;

        const newData = { ...oldData };

        Object.values(newData).forEach((e) => {
          e.find((account) => {
            const { key, unread_doc_count } = account;
            const found = key === selectedAccount;
            if (found) {
              if (!mail.read && unread_doc_count) {
                account.unread_doc_count -= 1;
              }
              account.doc_count -= 1;
            }
            return found;
          });
        });

        return newData;
      });

      const mailsCache = new MailsCache(selectedAccount, selectedCategory);

      mailsCache.set((oldData) => {
        if (!oldData) return oldData;
        const newData = [...oldData];
        newData.splice(i, 1);
        if (!newData.length) removeAccountFromQueryData();
        return newData;
      });
    }
  };

  const onClickStar = () => {
    requestMarkSaved(mail, !saved);
    markSavedInQueryData(mail, !saved);
  };

  const onClickRobot = () => {
    setIsSummaryOpen((v) => !v);
  };

  const classes = ["mailcard"];

  if (!mail.read) classes.push("unread");
  if (!isWriterOpen) classes.push("shadow");
  if (saved) classes.push("star");

  let searchHighlight;

  if ("highlight" in mail && mail.highlight) {
    searchHighlight = Object.values(mail.highlight).map((e) => {
      const __html = "..." + e.join("... ...") + "...";
      return <div dangerouslySetInnerHTML={{ __html }}></div>;
    });
  }

  const isKebabOpen = openedKebab === mail.id;

  const summary = ("insight" in mail ? mail.insight?.summary : undefined)?.map(
    (e, i) => {
      return <li key={`summary_${mail.id}_${i}`}>{e}</li>;
    }
  );

  const actionItems = (
    "insight" in mail ? mail.insight?.action_items : undefined
  )?.map((e, i) => {
    return <li key={`action_items_${mail.id}_${i}`}>{e}</li>;
  });

  return (
    <blockquote
      key={mail.id}
      className={classes.join(" ")}
      onMouseLeave={() => setOpenedKebab("")}
    >
      <MailHeader
        mail={mail}
        isActive={isActive}
        onClick={onClickMailcard}
        onMouseLeave={() => setOpenedKebab("")}
      />
      {isSummaryOpen && (
        <div className="insight">
          {!!summary?.length && (
            <div className="summary">
              <ul>{summary}</ul>
            </div>
          )}
          {!!actionItems?.length && (
            <div className="actionItem">
              <ul>{actionItems}</ul>
            </div>
          )}
        </div>
      )}
      {isActive ? (
        <MailBody mailId={mail.id} />
      ) : searchHighlight ? (
        <div className="search_highlight">{searchHighlight}</div>
      ) : null}
      <div
        className={
          "actionBox" + (isKebabOpen ? " open" : "") + (saved ? " saved" : "")
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
              {saved ? <SolidStarIcon className="star" /> : <EmptyStarIcon />}
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
            {!!(summary?.length || actionItems?.length) && (
              <div className="iconBox cursor" onClick={onClickRobot}>
                <RobotIcon />
              </div>
            )}
            {saved && (
              <div className="iconBox cursor" onClick={onClickStar}>
                <SolidStarIcon className="star" />
              </div>
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

interface ActiveMailMap {
  [k: string]: boolean;
}

const RenderedMails = ({ page }: { page: number }) => {
  const {
    isWriterOpen,
    setReplyData,
    selectedAccount,
    setSelectedAccount,
    selectedCategory
  } = useContext(Context);

  const [activeMailId, setActiveMailId] = useState<ActiveMailMap>({});
  const [openedKebab, setOpenedKebab] = useState("");

  const accountsCache = new AccountsCache();

  useEffect(() => {
    setActiveMailId({});
  }, [selectedAccount]);

  const touchStartHandler = () => setOpenedKebab("");

  useEffect(() => {
    window.addEventListener("touchstart", touchStartHandler);
    return () => {
      window.removeEventListener("touchstart", touchStartHandler);
    };
  }, []);

  const queryUrl = getMailsQueryUrl(selectedAccount, selectedCategory);

  const getMails = async () => {
    const { status, body, message } = await call.get<
      HeadersGetResponse | SearchGetResponse
    >(queryUrl);
    if (status === "success") return body || [];
    else throw new Error(message);
  };
  const query = useQuery<MailHeaderData[]>(queryUrl, getMails, {
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

  const requestDeleteMail = (mail: MailHeaderData) => {
    return call.delete<MailDeleteResponse>(`/api/mails/${mail.id}`);
  };

  const requestMarkRead = async (mail: MailHeaderData) => {
    type Response = MarkMailPostResponse;
    type Body = MarkMailPostBody;
    const body: Body = { mail_id: mail.id, read: true };
    return call.post<Response, Body>("/api/mails/mark", body);
  };

  const requestMarkSaved = (mail: MailHeaderData, save: boolean) => {
    type Response = MarkMailPostResponse;
    type Body = MarkMailPostBody;
    const body: Body = { mail_id: mail.id, save };
    return call.post<Response, Body>("/api/mails/mark", body);
  };

  const removeAccountFromQueryData = () => {
    accountsCache.set((oldData) => {
      if (!oldData) return oldData;

      const newData = { ...oldData };
      const key = selectedCategory === Category.SentMails ? "sent" : "received";
      newData[key].find((account, i) => {
        const found = account.key === selectedAccount;
        if (found) newData.received.splice(i, 1);
        return found;
      });

      return newData;
    });
  };

  const markReadInQueryData = (mail: MailHeaderData) => {
    const mailId = mail.id;

    Object.values(Category).forEach((e) => {
      const mailsCache = new MailsCache(selectedAccount, e);

      mailsCache.set((oldData) => {
        if (!oldData) return oldData;

        const newData = [...oldData];
        const foundData = newData.find((e) => e.id === mailId);
        if (foundData) foundData.read = true;

        return newData;
      });
    });

    accountsCache.set((oldData) => {
      if (!oldData) return oldData;

      const newData = { ...oldData };

      Object.values(newData).forEach((e) => {
        e.find((account) => {
          const { key, unread_doc_count } = account;
          const found = key === selectedAccount;
          if (found && unread_doc_count) account.unread_doc_count -= 1;
          return found;
        });
      });

      return newData;
    });
  };

  const markSavedInQueryData = (mail: MailHeaderData, save: boolean) => {
    const mailId = mail.id;
    accountsCache.set((oldData) => {
      if (!oldData) return oldData;
      const newData = { ...oldData };
      Object.values(newData).forEach((e) => {
        const found = e.find((f) => f.key === selectedAccount);
        if (found) {
          if (save) found.saved_doc_count++;
          else found.saved_doc_count--;
        }
      });
      return newData;
    });

    Object.values(Category).forEach((e) => {
      const mailsCache = new MailsCache(selectedAccount, e);

      mailsCache.set((oldData) => {
        if (!oldData) return oldData;
        const newData = [...oldData];
        let foundIndex;
        newData.find((e, i) => {
          if (e.id === mailId) {
            foundIndex = i;
            e.label = save ? "saved" : "";
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
      });
    });
  };

  if (query.isSuccess) {
    const mails = Array.isArray(query.data) ? query.data : [];
    const pagedMails = mails.slice(0, 4 + 8 * page);

    const result = pagedMails.map((mail, i) => {
      return (
        <RenderedMail
          key={mail.id}
          mail={mail}
          i={i}
          activeMailId={activeMailId}
          setActiveMailId={setActiveMailId}
          requestMarkRead={requestMarkRead}
          markReadInQueryData={markReadInQueryData}
          setReplyData={setReplyData}
          requestDeleteMail={requestDeleteMail}
          selectedAccount={selectedAccount}
          accountsCache={accountsCache}
          selectedCategory={selectedCategory}
          removeAccountFromQueryData={removeAccountFromQueryData}
          requestMarkSaved={requestMarkSaved}
          markSavedInQueryData={markSavedInQueryData}
          isWriterOpen={isWriterOpen}
          openedKebab={openedKebab}
          setOpenedKebab={setOpenedKebab}
        />
      );
    });

    return (
      <div className="mails_container">
        {result && result.length ? result : null}
      </div>
    );
  }

  return <></>;
};

const Mails = ({ page }: { page: number }) => {
  const { selectedAccount } = useContext(Context);
  if (!selectedAccount) return <GettingStarted />;
  else return <RenderedMails page={page} />;
};

export default Mails;
