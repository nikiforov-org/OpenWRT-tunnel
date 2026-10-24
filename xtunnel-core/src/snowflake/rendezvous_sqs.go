package snowflake_client

import (
	"errors"
	"net/http"
)

// The SQS rendezvous with the broker is left out (it links the AWS SDK); the rendezvous of the bridge
// lines through url=, front=/fronts= and ampcache= is unchanged.
type sqsRendezvous struct{}

func newSQSRendezvous(sqsQueue string, sqsCredsStr string, transport http.RoundTripper) (*sqsRendezvous, error) {
	return nil, errors.New("the SQS rendezvous is not supported by this build")
}

func (r *sqsRendezvous) Exchange(encPollReq []byte) ([]byte, error) {
	return nil, errors.New("the SQS rendezvous is not supported by this build")
}
