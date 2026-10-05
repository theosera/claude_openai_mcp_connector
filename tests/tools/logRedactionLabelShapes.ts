/** #295's five Issue-table shapes, with synthetic values replacing its ellipses. */
export const LABEL_SHAPES = [
  ...["access_token", "api_key", "client_secret"].map((label) => ({
    name: `compound label ${label}`,
    input: `<${label} a="S295C1" b="S295C2">S295C3</${label}> KEEP295C`,
    secrets: ["S295C1", "S295C2", "S295C3"],
    preserve: "KEEP295C",
    expected: `<${label} a="***MASKED***" b="***MASKED***">***MASKED***</${label}> KEEP295C`
  })),
  {
    name: "namespaced label",
    input: '<ns:password a="S295N1" b="S295N2">S295N3</ns:password> KEEP295N',
    secrets: ["S295N1", "S295N2", "S295N3"],
    preserve: "KEEP295N",
    expected: '<ns:password a="***MASKED***" b="***MASKED***">***MASKED***</ns:password> KEEP295N'
  },
  {
    name: "password input",
    input: '<input type="password" value="S295I1"> KEEP295I',
    secrets: ["S295I1"],
    preserve: "KEEP295I",
    expected: '<input type="***MASKED***" value="***MASKED***"> KEEP295I'
  },
  {
    name: "start tag across lines",
    input: '<password a="S295M1"\n b="S295M2">S295M3</password> KEEP295M',
    secrets: ["S295M1", "S295M2", "S295M3"],
    preserve: "KEEP295M",
    expected: '<password a="***MASKED***"\n b="***MASKED***">***MASKED***</password> KEEP295M'
  },
  ...["<", ">"].map((angle) => ({
    name: `angle ${angle} in later value`,
    input: `<password a="x" b="y${angle}z" c="S295A3"> KEEP295A`,
    secrets: ["y" + angle + "z", "S295A3"],
    preserve: "KEEP295A",
    expected: '<password a="***MASKED***" b="***MASKED***" c="***MASKED***"> KEEP295A'
  }))
] as const;
