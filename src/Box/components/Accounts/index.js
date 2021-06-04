import React from "react";
import { useQuery } from "react-query";

import "./index.scss";

const Accounts = ({ selectedAccount, setSelectedAccount }) => {
  const getAccounts = () => fetch("/api/accounts").then((r) => r.json());
  const queryData = useQuery("getAccounts", getAccounts);

  if (queryData.isLoading) {
    return (
      <div id="container-accounts" className="container">
        Loading Accounts List...
      </div>
    );
  }

  if (queryData.error) {
    return (
      <div id="container-accounts" className="container">
        Accounts List Request Failed
      </div>
    );
  }

  if (queryData.isSuccess) {
    const accounts = Array.isArray(queryData.data) ? queryData.data : null;

    const Accounts = () => {
      const result = accounts?.map((data, i) => {
        const onClickAccount = () => {
          if (selectedAccount !== data) setSelectedAccount(data);
        };

        let className = "";
        if (selectedAccount === data) className = "tag clicked";
        else className = "tag cursor";

        return (
          <h3 key={i} className={className} onClick={onClickAccount}>
            <span>{data.split("@")[0]}</span>
            {/* <div className="numberBall">{unreadNo}</div> */}
          </h3>
        );
      });

      return result || <></>;
    };

    return (
      <div id="container-accounts" className="pane side_pane">
        <Accounts />
      </div>
    );
  }
};

export default Accounts;
