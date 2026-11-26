// Re-encode a gnark Groth16 key in raw (uncompressed point) form. The ceremony tool writes keys with
// compressed points (WriteTo); Sunspot's verifier-program generator reads the raw form Sunspot's own
// setup writes (WriteRawTo). Either form is read back with ReadFrom, so this changes no key material.
// Built inside the pinned Sunspot module by circuit/scripts/sunspot-install.sh.
package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend/groth16"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: keyraw <in.pk|in.vk> <out>")
		os.Exit(2)
	}
	in, err := os.Open(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer in.Close()
	out, err := os.Create(os.Args[2])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer out.Close()
	if strings.HasSuffix(os.Args[1], ".vk") {
		vk := groth16.NewVerifyingKey(ecc.BN254)
		if _, err := vk.ReadFrom(in); err != nil {
			fmt.Fprintln(os.Stderr, "read vk:", err)
			os.Exit(1)
		}
		if _, err := vk.WriteRawTo(out); err != nil {
			fmt.Fprintln(os.Stderr, "write vk:", err)
			os.Exit(1)
		}
	} else {
		pk := groth16.NewProvingKey(ecc.BN254)
		if _, err := pk.ReadFrom(in); err != nil {
			fmt.Fprintln(os.Stderr, "read pk:", err)
			os.Exit(1)
		}
		if _, err := pk.WriteRawTo(out); err != nil {
			fmt.Fprintln(os.Stderr, "write pk:", err)
			os.Exit(1)
		}
	}
	fmt.Printf("wrote %s (raw encoding)\n", os.Args[2])
}
