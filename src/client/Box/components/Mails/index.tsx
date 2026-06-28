import {
  useState,
  useContext,
  useEffect,
  Dispatch,
  SetStateAction
} from "react";
import { useQuery, useQueryClient } from "react-query";
import { marked } from "marked";
import { MailBodyData, MailHeaderData, ReplyData } from "common";

import {
  ApiResponse,
  BodyGetResponse,
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
  NewTabIcon,
  ReplyIcon,
  ShareIcon,
  TrashIcon,
  EmptyStarIcon,
  SolidStarIcon,
  RobotIcon
} from "./components";

import {
  Context,
  Category,
  QueryCache,
  call,
  isSentMail,
  processHtmlForViewer
} from "client";
import { AccountsCache } from "client/Box/components/Accounts";

import "./index.scss";

const GettingStarted = () => {
  const queryUrl = "/text/getting_started.md";

  const fetchMessage = () => call.text(queryUrl).then((r) => marked(r));

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
  mail: MailHeaderData;
  i: number;
  activeMailId: ActiveMailMap;
  setActiveMailId: Dispatch<SetStateAction<ActiveMailMap>>;
  requestMarkRead: (
    mail: MailHeaderData
  ) => Promise<ApiResponse<MarkMailPostResponse>>;
  markReadInQueryData: (mail: MailHeaderData) => void;
  setReplyData: Dispatch<SetStateAction<ReplyData>>;
  requestDeleteMail: (
    mail: MailHeaderData
  ) => Promise<ApiResponse<MailDeleteResponse>>;
  selectedAccount: string;
  domainName: string;
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
  domainName,
  accountsCache,
  selectedCategory,
  removeAccountFromQueryData,
  requestMarkSaved,
  markSavedInQueryData,
  isWriterOpen,
  openedKebab,
  setOpenedKebab
}: RenderedMailProps) => {
  const isActive = !!activeMailId[mail.id];

  const [isSummaryOpen, setIsSummaryOpen] = useState(false);

  const queryClient = useQueryClient();

  const onClickOpenInNewTab = async () => {
    const queryUrl = `/api/mails/body/${mail.id}`;
    const getMail = () =>
      call.get<BodyGetResponse>(queryUrl).then(({ status, body, message }) => {
        if (status === "success") return new MailBodyData(body);
        throw new Error(message);
      });
    const data = await queryClient.fetchQuery<MailBodyData>(queryUrl, getMail, {
      staleTime: Infinity
    });
    // Render the email inside a sandboxed iframe in the new tab — NOT
    // directly into the top document. A `blob:` document inherits this
    // page's origin, so any script in the email body would otherwise run
    // with full inbox origin (cookies / session). The inline preview is
    // safe only because its iframe omits `allow-scripts`; the new tab must
    // preserve that backstop. The shell below carries no script of its own
    // and confines the email to an iframe whose sandbox matches the inline
    // viewer (no `allow-scripts`, no top-navigation), so email scripts stay
    // inert and `<meta http-equiv=refresh>` can't redirect the tab. The
    // sanitizer stays defense-in-depth, not the sole barrier.
    const processed = processHtmlForViewer(data.html);
    // Escape for embedding in the double-quoted `srcdoc` attribute.
    const srcdoc = processed.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const shell =
      '<!doctype html><html><head><meta charset="utf-8" />' +
      "<style>html,body{margin:0;padding:0;height:100%}" +
      "iframe{border:0;width:100%;height:100%}</style></head>" +
      '<body><iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" ' +
      `srcdoc="${srcdoc}"></iframe></body></html>`;
    const blob = new Blob([shell], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    // Revoke after a delay so the new tab has a chance to load. Chrome /
    // Safari hold the blob alive in the open tab regardless once the
    // load is committed.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

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
    // The Writer derives the composer's "From" from `replyData.to.address`
    // and the composer's "To" from `replyData.from.value[0].address`. For
    // received mail that lines up naturally; for sent mail surfaced via
    // search (or Sent Mails), we swap `from`/`to` so Reply addresses the
    // original recipient — not the user themselves. See #510.
    if (isSentMail(mail, domainName)) {
      const ownAddress = mail.from?.value?.[0]?.address || selectedAccount;
      setReplyData({ ...mail, from: mail.to, to: { address: ownAddress } });
    } else {
      setReplyData({ ...mail, to: { address: selectedAccount } });
    }
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

        // Only update the array that matches the current view (received vs sent),
        // so an address present in both arrays isn't double-decremented.
        const arrayKey =
          selectedCategory === Category.SentMails ? "sent" : "received";
        newData[arrayKey].find((account) => {
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
    requestMarkSaved(mail, !mail.saved);
    markSavedInQueryData(mail, !mail.saved);
  };

  const onClickRobot = () => {
    setIsSummaryOpen((v) => !v);
  };

  const classes = ["mailcard"];

  if (!mail.read) classes.push("unread");
  if (!isWriterOpen) classes.push("shadow");
  if (mail.saved) classes.push("star");

  let searchHighlight;

  if ("highlight" in mail && mail.highlight) {
    searchHighlight = Object.values(mail.highlight).map((e, index) => {
      // Sanitize ts_headline output: escape all HTML, then allow only <em>/<\/em>
      // which are the StartSel/StopSel delimiters set server-side in the ts_headline call
      const sanitize = (fragment: string) =>
        fragment
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/&lt;em&gt;/g, "<em>")
          .replace(/&lt;\/em&gt;/g, "</em>");
      const __html = "..." + e.map(sanitize).join("... ...") + "...";
      return (
        <div key={`highlight_${index}`} dangerouslySetInnerHTML={{ __html }} />
      );
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
          "actionBox" +
          (isKebabOpen ? " open" : "") +
          (mail.saved ? " saved" : "")
        }
      >
        {isKebabOpen ? (
          <>
            <div
              key="star"
              className="iconBox cursor"
              onClick={onClickStar}
              onTouchStart={(e) => e.stopPropagation()}
              onMouseEnter={() => setOpenedKebab(mail.id)}
            >
              {mail.saved ? (
                <SolidStarIcon className="star" />
              ) : (
                <EmptyStarIcon />
              )}
            </div>
            <div
              key="openInNewTab"
              className="iconBox cursor"
              onClick={onClickOpenInNewTab}
              onTouchStart={(e) => e.stopPropagation()}
              onMouseEnter={() => setOpenedKebab(mail.id)}
              title="Open this email body in a new tab"
            >
              <NewTabIcon />
            </div>
            <div
              key="reply"
              className="iconBox cursor"
              onClick={onClickReply}
              onTouchStart={(e) => e.stopPropagation()}
              onMouseEnter={() => setOpenedKebab(mail.id)}
            >
              <ReplyIcon />
            </div>
            <div
              key="share"
              className="iconBox cursor"
              onClick={onClickShare}
              onTouchStart={(e) => e.stopPropagation()}
              onMouseEnter={() => setOpenedKebab(mail.id)}
            >
              <ShareIcon />
            </div>
            <div
              key="trash"
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
            {summary?.length || actionItems?.length ? (
              <div
                key="robot"
                className="iconBox cursor"
                onClick={onClickRobot}
              >
                <RobotIcon />
              </div>
            ) : null}
            {mail.saved ? (
              <div key="star" className="iconBox cursor" onClick={onClickStar}>
                <SolidStarIcon className="star" />
              </div>
            ) : null}
            <div
              key="kebab"
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
    selectedCategory,
    domainName
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
    if (status === "success") {
      return body?.map((d) => new MailHeaderData(d)) || [];
    } else throw new Error(message);
  };
  const query = useQuery<MailHeaderData[]>(queryUrl, getMails);

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
        if (found) newData[key].splice(i, 1);
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

      // Only update the array that matches the current view (received vs sent),
      // so an address present in both arrays isn't double-decremented.
      const arrayKey =
        selectedCategory === Category.SentMails ? "sent" : "received";
      newData[arrayKey].find((account) => {
        const { key, unread_doc_count } = account;
        const found = key === selectedAccount;
        if (found && unread_doc_count) account.unread_doc_count -= 1;
        return found;
      });

      return newData;
    });
  };

  const markSavedInQueryData = (mail: MailHeaderData, save: boolean) => {
    const mailId = mail.id;
    accountsCache.set((oldData) => {
      if (!oldData) return oldData;
      const newData = { ...oldData };
      // Only update the array that matches the current view (received vs sent).
      const arrayKey =
        selectedCategory === Category.SentMails ? "sent" : "received";
      const found = newData[arrayKey].find((f) => f.key === selectedAccount);
      if (found) {
        if (save) found.saved_doc_count++;
        else found.saved_doc_count--;
      }
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
            e.saved = save;
            return true;
          }
          return false;
        });
        if (e === Category.SavedMails) {
          if (foundIndex !== undefined) newData.splice(foundIndex, 1);
          else {
            let i = 0;
            while (new Date(newData[i]?.date) > new Date(mail.date)) i++;
            newData.splice(i, 0, new MailHeaderData({ ...mail }));
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
          domainName={domainName}
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

    if (!result.length) {
      const emptyMessage = (() => {
        switch (selectedCategory) {
          case Category.NewMails:
            return "All caught up! No unread emails.";
          case Category.SavedMails:
            return "No saved emails.";
          case Category.SentMails:
            return "No sent emails.";
          case Category.Search:
            return "No results found.";
          default:
            return "No emails in this account.";
        }
      })();
      return (
        <div className="mails_container empty">
          <p className="empty_state">{emptyMessage}</p>
        </div>
      );
    }

    return <div className="mails_container">{result}</div>;
  }

  return <></>;
};

const Mails = ({ page }: { page: number }) => {
  const { selectedAccount } = useContext(Context);
  if (!selectedAccount) return <GettingStarted />;
  else return <RenderedMails page={page} />;
};

export default Mails;
