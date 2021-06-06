import React, { useContext, useEffect } from "react";
import { useQuery } from "react-query";

import FileIcon from "../../../FileIcon";

import { Context } from "../../../../..";

const MailBody = ({ mailId }) => {
  const { replyData, setReplyData } = useContext(Context);

  const getMail = () => {
    return fetch(`/api/mailContent/${mailId}`).then((r) => r.json());
  };
  const query = useQuery(`getMail_${mailId}`, getMail);

  useEffect(() => {
    if (replyData.id && query.data.html && replyData.html !== query.data.html) {
      setReplyData(query.data.html);
    }
  }, [replyData, setReplyData, query]);

  if (query.isLoading) {
    return <div className="text">Loading Mail Data...</div>;
  }

  if (query.error) {
    return <div className="text">Mail Data Request Failed</div>;
  }

  const data = query.data;

  if (query.isSuccess && data) {
    const Attachments = () => {
      const result = data.attachments?.map((attachment, i) => {
        const onClickAttachment = () => {
          fetch(`/api/attachment/${attachment.content.data}`)
            .then((r) => r.arrayBuffer())
            .then((r) => {
              const link = document.createElement("a");
              const blob = new Blob([r], { type: attachment.contentType });
              const objectUrl = URL.createObjectURL(blob);
              link.href = objectUrl;
              link.target = "_black";
              link.download = attachment.filename;
              link.click();
            });
        };
        return (
          <div
            key={i}
            className="attachment cursor"
            onClick={onClickAttachment}
          >
            <FileIcon />
            <span>{attachment.filename}</span>
          </div>
        );
      });

      return <div className="attachmentBox">{result}</div> || <></>;
    };

    const iframeSrcDoc = `
      <style>
          body {
              margin: 0;
              overflow-y: hidden;
          }
          * {
              font-family: "Open Sans", -apple-system, BlinkMacSystemFont, "Segoe UI",
              "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans",
              "Helvetica Neue", sans-serif;
              color: rgb(70,70,70);
          }
      </style>
      ${data.html}
    `;

    const onLoadIframe = (e) => {
      const iframeDom = e.target;
      const iframeContent = iframeDom.contentWindow;
      const iframeContentHeight = iframeContent.document.body.scrollHeight;
      iframeDom.style.height = iframeContentHeight + 32 + "px";
    };

    return (
      <div className="text">
        <Attachments />
        <iframe title={data.id} srcDoc={iframeSrcDoc} onLoad={onLoadIframe} />
      </div>
    );
  }
};

export default MailBody;
