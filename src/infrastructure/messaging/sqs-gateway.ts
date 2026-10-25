import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config.ts';

export interface ReceivedMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  receiveCount: number;
}

@Injectable()
export class SqsGateway {
  private readonly client: SQSClient;
  private readonly urls = new Map<string, string>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = new SQSClient({
      region: config.awsRegion,
      endpoint: config.sqsEndpoint,
      credentials: {
        accessKeyId: config.awsAccessKeyId,
        secretAccessKey: config.awsSecretAccessKey,
      },
    });
  }

  async ping(): Promise<void> {
    await this.queueUrl(this.config.wagerQueueName);
  }

  async publish(queueName: string, body: unknown, groupId: string, deduplicationId: string): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: await this.queueUrl(queueName),
      MessageBody: JSON.stringify(body),
      MessageGroupId: groupId.slice(0, 128),
      MessageDeduplicationId: deduplicationId.slice(0, 128),
    }));
  }

  async receive(
    queueName: string,
    options: { waitTimeSeconds: number; visibilityTimeout: number; signal?: AbortSignal },
  ): Promise<ReceivedMessage[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queueUrl(queueName),
        MaxNumberOfMessages: 5,
        WaitTimeSeconds: options.waitTimeSeconds,
        VisibilityTimeout: options.visibilityTimeout,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
      { abortSignal: options.signal },
    );
    return (result.Messages ?? []).flatMap((message) => {
      if (!message.MessageId || !message.ReceiptHandle || message.Body === undefined) return [];
      return [{
        messageId: message.MessageId,
        receiptHandle: message.ReceiptHandle,
        body: message.Body,
        receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? '1'),
      }];
    });
  }

  async delete(queueName: string, receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({
      QueueUrl: await this.queueUrl(queueName),
      ReceiptHandle: receiptHandle,
    }));
  }

  async changeVisibility(queueName: string, receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: await this.queueUrl(queueName),
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: seconds,
    }));
  }

  destroy(): void {
    this.client.destroy();
  }

  private async queueUrl(name: string): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const result = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!result.QueueUrl) throw new Error(`Queue ${name} was not found`);
    this.urls.set(name, result.QueueUrl);
    return result.QueueUrl;
  }
}
