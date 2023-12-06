import { Handler, SNSEvent } from "aws-lambda";
import { App } from "@slack/bolt";
import { getParameter } from "@aws-lambda-powertools/parameters/ssm";
import {
  CloudWatchLogsClient,
  DescribeMetricFiltersCommand,
  FilterLogEventsCommand,
  FilteredLogEvent,
  DescribeLogStreamsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const AWS_REGION = process.env.AWS_REGION;

type SNSEventMessage = {
  AlarmName: string;
  StateChangeTime: string;
  Trigger: {
    MetricName: string;
    Namespace: string;
  };
};

type Log = {
  alarmName: string;
  filterPattern: string;
  logGroupName: string;
  logStreamName: string;
  events: FilteredLogEvent[];
};

type Slack = {
  token: string;
  channel: string;
  signingSecret: string;
};

export const handler: Handler = async (event: SNSEvent) => {
  console.info("EVENT: \n" + JSON.stringify(event, null, 2));

  if (!event.Records.length) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "No event records",
      }),
    };
  }

  const snsMessage: SNSEventMessage = JSON.parse(event.Records[0].Sns.Message);

  const log = await describeLogs(snsMessage);
  if (!log || !log.events.length) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "No logs",
      }),
    };
  }

  const result = await sendToSlack(log);
  console.info("RESULT: \n" + JSON.stringify(result, null, 2));

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Success",
    }),
  };
};

const describeLogs = async (message: SNSEventMessage): Promise<Log | null> => {
  const c = new CloudWatchLogsClient({ region: AWS_REGION });

  const metricFiltersOutput = await c.send(
    new DescribeMetricFiltersCommand({
      metricName: message.Trigger.MetricName,
      metricNamespace: message.Trigger.Namespace,
    })
  );
  const logGroupName = metricFiltersOutput.metricFilters?.[0].logGroupName;
  const filterPattern = metricFiltersOutput.metricFilters?.[0].filterPattern;
  if (!logGroupName || !filterPattern) {
    return null;
  }

  const logStreamOutput = await c.send(
    new DescribeLogStreamsCommand({
      logGroupName,
      descending: true,
      orderBy: "LastEventTime",
      limit: 1,
    })
  );
  const logStreamName = logStreamOutput.logStreams?.[0].logStreamName;
  if (!logStreamName) {
    return null;
  }

  const to = new Date(message.StateChangeTime);
  to.setMinutes(to.getMinutes() + 1);
  const from = new Date(to);
  from.setMinutes(from.getMinutes() - 5);

  const log = await c.send(
    new FilterLogEventsCommand({
      logGroupName,
      filterPattern,
      logStreamNames: [logStreamName],
      startTime: from.valueOf(),
      endTime: to.valueOf(),
      limit: 10,
    })
  );

  return {
    alarmName: message.AlarmName,
    filterPattern,
    logGroupName,
    logStreamName,
    events: log.events || [],
  };
};

const createCloudWatchLogUrl = (log: Log) => {
  const encode = (v: string) => {
    // encode URI twice, because AWS console url is encoded twice.
    const encoded = encodeURIComponent(v);
    return encodeURIComponent(encoded);
  };
  return `https://${AWS_REGION}.console.aws.amazon.com/cloudwatch/home?region=${AWS_REGION}#logsV2:log-groups/log-group/${encode(
    log.logGroupName
  )}/log-events/${encode(log.logStreamName)}`;
};

const getSlackParameter = async (): Promise<Slack> => {
  return {
    token: (await getParameter(process.env.SLACK_TOKEN || "", {
      decrypt: true,
    })) as string,
    channel: (await getParameter(process.env.SLACK_CHANNEL || "", {
      decrypt: true,
    })) as string,
    signingSecret: (await getParameter(process.env.SLACK_SIGNING_SECRET || "", {
      decrypt: true,
    })) as string,
  };
};

const sendToSlack = async (log: Log) => {
  try {
    const parameter = await getSlackParameter();
    if (!parameter.channel || !parameter.token || !parameter.signingSecret) {
      return;
    }

    const app = new App({
      token: parameter.token,
      signingSecret: parameter.signingSecret,
    });

    return await Promise.all(
      log.events.map((event) => {
        //////////////////////////////////////////
        // get value from log message. This is a sample.
        const code = 500;
        const timestamp = new Date().toLocaleString();
        const api = "GET /users";
        const errorLog = event.message;
        //////////////////////////////////////////

        return app.client.chat.postMessage({
          channel: parameter.channel,
          attachments: [
            {
              mrkdwn_in: ["text"],
              color: code >= 500 ? "danger" : "warning",
              title: log.alarmName,
              title_link: createCloudWatchLogUrl(log),
              text: errorLog,
              fallback: errorLog,
              fields: [
                {
                  title: "Timestamp",
                  value: timestamp,
                  short: true,
                },
                {
                  title: "ErrorCode",
                  value: code.toString(),
                  short: true,
                },
                {
                  title: "API",
                  value: api,
                  short: true,
                },
                {
                  title: "Assignee",
                  value: "<!channel>",
                  short: true,
                },
              ],
            },
          ],
        });
      })
    );
  } catch (error) {
    console.error(error);
  }
};
