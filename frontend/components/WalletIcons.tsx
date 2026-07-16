// Brand SVG icons for wallet connectors.
// Lucide doesn't include wallet brand logos, so these are hand-rolled SVGs.

export function MetaMaskIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 35 33" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M32.958 1L19.188 10.856l2.465-5.84L32.958 1Z" fill="#E2761B" stroke="#E2761B" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M2.029 1l13.65 9.948-2.344-5.932L2.029 1Z" fill="#E4761B" stroke="#E4761B" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M28.18 23.525l-3.663 5.611 7.842 2.158 2.252-7.647-6.431-.122ZM.403 23.647l2.24 7.647 7.841-2.158-3.663-5.611-6.418.122Z" fill="#E4761B" stroke="#E4761B" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M10.093 14.375l-2.192 3.31 7.817.352-.274-8.396-5.351 4.734ZM24.894 14.375l-5.413-4.826-.183 8.488 7.806-.352-2.21-3.31Z" fill="#E4761B" stroke="#E4761B" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="m10.484 29.136 4.703-2.28-4.063-3.165-.64 5.445ZM19.8 26.856l4.714 2.28-.65-5.445-4.064 3.165Z" fill="#E4761B" stroke="#E4761B" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="m24.514 29.136-4.714-2.28.376 3.074-.04 1.25 4.378-2.044ZM10.484 29.136l4.378 2.044-.03-1.25.366-3.074-4.714 2.28Z" fill="#D7C1B3" stroke="#D7C1B3" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="m14.94 21.922-3.917-1.149 2.769-1.27 1.148 2.419ZM20.047 21.922l1.148-2.419 2.78 1.27-3.928 1.149Z" fill="#233447" stroke="#233447" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="m10.484 29.136.66-5.611-4.323.122 3.663 5.489ZM23.844 23.525l.65 5.611 3.674-5.489-4.324-.122ZM27.108 17.685l-7.806.352.723 3.885 1.148-2.419 2.78 1.27 3.155-3.088ZM11.023 20.773l2.78-1.27 1.139 2.419.733-3.885-7.817-.352 3.165 3.088Z" fill="#CD6116" stroke="#CD6116" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="m7.9 17.685 3.276 6.39-.112-3.302L7.9 17.685ZM23.934 20.773l-.122 3.302 3.285-6.39-3.163 3.088ZM15.717 18.037l-.733 3.885.916 4.724.213-6.237-.396-2.372ZM19.302 18.037l-.386 2.362.183 6.247.925-4.724-.722-3.885Z" fill="#E4751F" stroke="#E4751F" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="m20.047 21.922-.925 4.724.661.457 4.064-3.165.122-3.302-3.922 1.286ZM11.023 20.773l.112 3.302 4.063 3.165.662-.457-.916-4.724-3.921-1.286Z" fill="#F6851B" stroke="#F6851B" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="m20.118 31.18.04-1.25-.346-.305h-5.137l-.325.305.03 1.25-4.377-2.044 1.53 1.25 3.094 2.15h5.31l3.105-2.15 1.52-1.25-4.444 2.044Z" fill="#C0AD9E" stroke="#C0AD9E" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="m19.8 26.856-.66-.457h-3.297l-.66.457-.366 3.074.325-.305h5.137l.346.305-.825-3.074Z" fill="#161616" stroke="#161616" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="m33.516 11.316.91-4.398L32.958 1l-13.17 9.765 5.106 4.31 7.196 2.107 1.59-1.86-.69-.499 1.097-1.006-.844-.65 1.097-.854-.824-.597ZM.561 6.918l.92 4.398-.538.397 1.097.854-.834.65 1.097 1.006-.69.499 1.581 1.86 7.196-2.107 5.107-4.31L2.029 1 .561 6.918Z" fill="#763D16" stroke="#763D16" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="m32.09 16.182-7.196-2.107 2.21 3.31-3.285 6.39 4.323-.122h6.43l-2.483-7.471ZM10.093 14.075l-7.196 2.107-2.444 7.465h6.418l4.313.122-3.275-6.39 2.184-3.304ZM19.302 18.037l.457-7.97 2.09-5.657h-9.296l2.06 5.657.487 7.97.183 2.392.01 6.227h3.297l.021-6.227.691-2.392Z" fill="#F6851B" stroke="#F6851B" strokeWidth=".25" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export function CoinbaseIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" rx="8" fill="#0052FF"/>
      <path d="M16 6C10.477 6 6 10.477 6 16s4.477 10 10 10 10-4.477 10-10S21.523 6 16 6zm0 4a6 6 0 0 1 5.292 3.167H10.708A6 6 0 0 1 16 10zm-6.292 8.833A6 6 0 0 1 10 16c0-.29.021-.575.062-.853h11.876c.04.278.062.563.062.853a6 6 0 0 1-.292 1.833H9.708zM16 22a6 6 0 0 1-5.292-3.167h10.584A6 6 0 0 1 16 22z" fill="white"/>
    </svg>
  );
}

export function BinanceIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" rx="8" fill="#F3BA2F"/>
      <path d="M12.116 13.884L16 10l3.886 3.886 2.26-2.26L16 5.48l-6.144 6.144 2.26 2.26ZM6 16l2.26-2.26L10.52 16l-2.26 2.26L6 16Zm6.116 2.116L16 22l3.886-3.886 2.26 2.26L16 26.52l-6.144-6.144.002-.002 2.258-2.258ZM21.48 16l2.26-2.26L26 16l-2.26 2.26L21.48 16Zm-3.192 0H16v.002h-.002V16h-2.286v.002H13.71V16h-.002v-.002H11.42v.002H11.42V16h2.288v-.002H13.71V16h2.286v.002H16V16h2.288v-.002H18.29V16Z" fill="white"/>
    </svg>
  );
}
