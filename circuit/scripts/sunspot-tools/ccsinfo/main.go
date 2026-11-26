// Print the size of a gnark R1CS (.ccs from `sunspot compile`): what a Groth16 phase 1 must cover.
// Built inside the pinned Sunspot module by circuit/scripts/sunspot-install.sh.
package main

import (
	"fmt"
	"math/bits"
	"os"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: ccsinfo <file.ccs>")
		os.Exit(2)
	}
	f, err := os.Open(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer f.Close()
	ccs := groth16.NewCS(ecc.BN254)
	if _, err := ccs.ReadFrom(f); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	constraints := ccs.GetNbConstraints()
	public := ccs.GetNbPublicVariables()
	secret := ccs.GetNbSecretVariables()
	internal := ccs.GetNbInternalVariables()
	// Groth16 phase 1 needs powers of tau up to the domain size: the next power of two at or above
	// constraints + public inputs (gnark's domain cardinality).
	domain := constraints + public
	power := bits.Len(uint(domain - 1))
	fmt.Printf("constraints=%d public=%d secret=%d internal=%d domain=%d power=%d\n",
		constraints, public, secret, internal, domain, power)
}
