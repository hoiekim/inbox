import React from "react";

const SkeletonAccount = () => {
  return (
    <div>
      <div
        className="tag skeleton loading_animation"
        style={{ width: 70 + 50 * Math.random() }}
      >
        <span>&nbsp;</span>
      </div>
    </div>
  );
};

export default SkeletonAccount;
