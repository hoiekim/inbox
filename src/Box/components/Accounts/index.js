import React, { useContext, useEffect } from "react";
import { useQuery } from "react-query";

import { Context } from "../../..";

const Accounts = () => {
  const checkAccounts = () => fetch("/api/accounts").then((r) => r.json());
  const queryData = useQuery("checkAccounts", checkAccounts, { cacheTime: 0 });

  const { setRefetchAccounts } = useContext(Context);

  //   useEffect(() => {
  //     if (queryData.refetch && setRefetchAccounts) {
  //       setRefetchAccounts(queryData.refetch);
  //     }
  //   }, [queryData.refetch, setRefetchAccounts]);

  if (queryData.isLoading || queryData.error) return <></>;

  const accounts = Array.isArray(queryData.data) ? queryData.data : null;

  const Account = accounts?.map((data, i) => {
    const accountName = data.split("@")[0];
    return (
      <h3 key={i} className="tag cursor">
        <span>{accountName}</span>
        {/* <div className="numberBall">{unreadNo}</div> */}
      </h3>
    );
  });

  return (
    <div id="container-accounts" className="container">
      {Account}
    </div>
  );
};

export default Accounts;
