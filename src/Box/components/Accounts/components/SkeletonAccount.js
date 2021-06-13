import React from "react";

const SkeletonAccount = () => {
  return (
    <div>
      <h3 className="tag skeleton" style={{ width: 70 + 50 * Math.random() }}>
        <span>&nbsp;</span>
      </h3>
    </div>
  );
};

export default SkeletonAccount;
